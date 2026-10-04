'use strict'

const {
  FST_ERR_PROJECTION_INVALID,
  FST_ERR_PROJECTION_AMBIGUOUS
} = require('./errors')

const DEFAULT_REPLACEMENT = '[REDACTED]'
const VALID_ACTIONS = ['remove', 'replace']
const VALID_AMBIGUOUS_STRATEGIES = ['error', 'redact-subtree']
// Schema combinators for which the matching branch cannot be uniquely
// determined at compile time. Crossing one of these while resolving a
// sensitive path is ambiguous and must never be guessed.
const AMBIGUOUS_KEYS = ['oneOf', 'anyOf', 'not', 'if', 'then', 'else']

/**
 * Parses a sensitive path such as `users[*].token` into segments.
 * `[*]` (or a bare `*`) selects every item of an array.
 */
function parsePath (path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new FST_ERR_PROJECTION_INVALID('projection paths must be non-empty strings')
  }
  const segments = []
  for (let part of path.split('.')) {
    part = part.trim()
    if (part === '') {
      throw new FST_ERR_PROJECTION_INVALID(`invalid empty segment in path '${path}'`)
    }
    if (part === '*') {
      segments.push('*')
    } else if (part.endsWith('[*]')) {
      const name = part.slice(0, -3)
      if (name !== '') {
        segments.push(name)
      }
      segments.push('*')
    } else {
      segments.push(part)
    }
  }
  return segments
}

/**
 * Validates and normalizes the route `projection` option.
 * Throws synchronously on invalid configuration.
 */
function normalizeProjectionConfig (projection) {
  if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new FST_ERR_PROJECTION_INVALID('projection must be an object')
  }

  const {
    paths,
    action = 'remove',
    replacement = DEFAULT_REPLACEMENT,
    onAmbiguous = 'error'
  } = projection

  if (!VALID_ACTIONS.includes(action)) {
    throw new FST_ERR_PROJECTION_INVALID(`projection action must be one of ${VALID_ACTIONS.join(', ')}`)
  }
  if (!VALID_AMBIGUOUS_STRATEGIES.includes(onAmbiguous)) {
    throw new FST_ERR_PROJECTION_INVALID(`projection onAmbiguous must be one of ${VALID_AMBIGUOUS_STRATEGIES.join(', ')}`)
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new FST_ERR_PROJECTION_INVALID('projection paths must be a non-empty array')
  }

  const parsedPaths = paths.map((entry) => {
    let path
    let entryAction = action
    let entryReplacement = replacement
    if (typeof entry === 'string') {
      path = entry
    } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      path = entry.path
      if (entry.action !== undefined) {
        if (!VALID_ACTIONS.includes(entry.action)) {
          throw new FST_ERR_PROJECTION_INVALID(`projection path action must be one of ${VALID_ACTIONS.join(', ')}`)
        }
        entryAction = entry.action
      }
      if (entry.replacement !== undefined) {
        entryReplacement = entry.replacement
      }
    } else {
      throw new FST_ERR_PROJECTION_INVALID('projection paths entries must be strings or objects')
    }
    return {
      segments: parsePath(path),
      action: entryAction,
      replacement: entryReplacement,
      source: typeof path === 'string' ? path : String(path)
    }
  })

  return { parsedPaths, action, replacement, onAmbiguous }
}

function makeTreeNode () {
  return { children: new Map(), action: null }
}

function getChildNode (node, segment) {
  let child = node.children.get(segment)
  if (child === undefined) {
    child = makeTreeNode()
    node.children.set(segment, child)
  }
  return child
}

function makeAction (type, replacement) {
  return type === 'replace' ? { type, replacement } : { type }
}

function cloneTree (node) {
  const copy = makeTreeNode()
  copy.action = node.action
  for (const [segment, child] of node.children) {
    copy.children.set(segment, cloneTree(child))
  }
  return copy
}

/**
 * Builds the base projection tree from the parsed sensitive paths.
 * The base tree always applies, even for status codes without a
 * response schema: removing an explicitly declared sensitive field is
 * always safe and never leaks.
 */
function buildBaseTree (config) {
  const root = makeTreeNode()
  for (const parsed of config.parsedPaths) {
    let node = root
    for (const segment of parsed.segments) {
      node = getChildNode(node, segment)
    }
    node.action = makeAction(parsed.action, parsed.replacement)
  }
  return root
}

function unescapePointer (segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * Resolves a JSON Schema `$ref` against the route schema bucket.
 * Returns the resolved schema and its document root, or null when the
 * reference cannot be resolved.
 */
function resolveRef (ref, currentRoot, schemas) {
  const hashIdx = ref.indexOf('#')
  const id = hashIdx === -1 ? ref : ref.slice(0, hashIdx)
  const pointer = hashIdx === -1 ? '' : ref.slice(hashIdx + 1)

  let root = currentRoot
  if (id !== '') {
    root = schemas[id] || schemas[id.endsWith('/') ? id.slice(0, -1) : id + '/']
    if (root === undefined) {
      return null
    }
  }

  let target = root
  if (pointer !== '' && pointer !== '/') {
    const parts = pointer.split('/').slice(1).map(unescapePointer)
    for (const part of parts) {
      if (target === null || typeof target !== 'object') {
        return null
      }
      target = target[part]
    }
  }
  if (target === undefined || target === null) {
    return null
  }
  return { target, root }
}

/**
 * Walks a single sensitive path against a status code response schema,
 * resolving `$ref`s (cycle safe). When the path crosses an ambiguous
 * combinator (oneOf/anyOf/if-then-else/not) the configuration is either
 * rejected (default) or the whole subtree at that location is marked for
 * redaction, depending on the explicit `onAmbiguous` strategy. Branches
 * are never guessed.
 */
function walkSchemaPath (rootSchema, schema, segments, idx, treeNode, config, statusCode, schemas, stack) {
  if (idx >= segments.length) {
    return true
  }
  if (schema === null || typeof schema !== 'object') {
    return false
  }

  // Resolve chains of $ref, guarding against circular references.
  let current = schema
  let currentRoot = rootSchema
  let guard = 0
  while (current !== null && typeof current === 'object' && typeof current.$ref === 'string') {
    if (stack.has(current)) {
      return false
    }
    stack.add(current)
    const resolved = resolveRef(current.$ref, currentRoot, schemas)
    if (resolved === null) {
      // Unresolvable reference: stop the static walk. The base tree still
      // applies the sensitive path at runtime, so nothing leaks.
      return false
    }
    current = resolved.target
    currentRoot = resolved.root
    if (++guard > 100) {
      return false
    }
  }

  if (current === null || typeof current !== 'object' || stack.has(current)) {
    return false
  }
  stack.add(current)
  try {
    for (const key of AMBIGUOUS_KEYS) {
      if (current[key] !== undefined) {
        if (config.onAmbiguous === 'error') {
          throw new FST_ERR_PROJECTION_AMBIGUOUS(segments.join('.'), statusCode, key)
        }
        // 'redact-subtree': redact the whole value at this location.
        treeNode.action = makeAction(config.action, config.replacement)
        return true
      }
    }

    let matched = false

    if (Array.isArray(current.allOf)) {
      for (const subSchema of current.allOf) {
        if (walkSchemaPath(currentRoot, subSchema, segments, idx, treeNode, config, statusCode, schemas, stack)) {
          matched = true
        }
      }
    }

    const segment = segments[idx]
    if (segment === '*') {
      const items = current.items
      const itemSchemas = Array.isArray(items) ? items : [items]
      for (const itemSchema of itemSchemas) {
        if (itemSchema !== null && typeof itemSchema === 'object') {
          const child = getChildNode(treeNode, '*')
          if (walkSchemaPath(currentRoot, itemSchema, segments, idx + 1, child, config, statusCode, schemas, stack)) {
            matched = true
          }
        }
      }
    } else {
      const properties = current.properties
      if (properties !== null && typeof properties === 'object' && properties[segment] !== undefined) {
        const child = getChildNode(treeNode, segment)
        const walked = walkSchemaPath(
          currentRoot, properties[segment], segments, idx + 1, child, config, statusCode, schemas, stack
        )
        if (walked) {
          matched = true
        }
      }
    }

    return matched
  } finally {
    stack.delete(current)
  }
}

/**
 * Extracts the JSON schema for a response definition, unwrapping
 * content-type keyed definitions when present.
 */
function unwrapResponseSchema (definition) {
  if (definition === null || typeof definition !== 'object') {
    return null
  }
  if (definition.content !== null && typeof definition.content === 'object') {
    const content = definition.content
    const entry = content['application/json'] || content[Object.keys(content)[0]]
    return (entry !== null && typeof entry === 'object' && entry.schema !== undefined) ? entry.schema : null
  }
  return definition
}

/**
 * Compiles the route projection into per-status-code projection trees.
 */
function compileProjection (config, responseSchemas, schemas) {
  const base = buildBaseTree(config)

  if (responseSchemas === null || typeof responseSchemas !== 'object') {
    return { base, byStatus: null }
  }

  let byStatus = null
  for (const statusCode of Object.keys(responseSchemas)) {
    const schema = unwrapResponseSchema(responseSchemas[statusCode])
    if (schema === null || typeof schema !== 'object') {
      continue
    }
    const tree = cloneTree(base)
    for (const parsed of config.parsedPaths) {
      walkSchemaPath(schema, schema, parsed.segments, 0, tree, config, statusCode, schemas, new Set())
    }
    if (byStatus === null) {
      byStatus = Object.create(null)
    }
    byStatus[statusCode] = tree
  }

  return { base, byStatus }
}

/**
 * Selects the projection tree for a response status code, mirroring the
 * response serializer lookup: exact match, `Nxx` wildcard, `default`,
 * then the base tree built from the raw sensitive paths.
 */
function selectProjectionTree (projection, statusCode) {
  if (projection.byStatus !== null) {
    const code = String(statusCode)
    const tree = projection.byStatus[code] ||
      projection.byStatus[code.charAt(0) + 'xx'] ||
      projection.byStatus.default
    if (tree !== undefined) {
      return tree
    }
  }
  return projection.base
}

function isArrayIndex (segment) {
  if (segment === '' || segment.length > 10) {
    return false
  }
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i)
    if (c < 48 || c > 57) {
      return false
    }
  }
  return true
}

/**
 * Applies a projection tree to a payload using copy-on-write: the object
 * returned by the route handler is never mutated and, when no sensitive
 * field is present, the payload is returned as-is (same reference).
 * Circular payload structures are tolerated.
 */
function applyProjection (payload, tree) {
  return projectValue(payload, tree, new Set())
}

function projectValue (value, node, seen) {
  if (value === null || typeof value !== 'object' || node.children.size === 0) {
    return value
  }
  if (seen.has(value)) {
    return value
  }
  seen.add(value)
  try {
    let result = value

    const starNode = node.children.get('*')
    if (starNode !== undefined && Array.isArray(result)) {
      if (starNode.action !== null) {
        // Iterate backwards so removals do not shift upcoming indexes.
        for (let i = result.length - 1; i >= 0; i--) {
          if (result === value) {
            result = value.slice()
          }
          if (starNode.action.type === 'remove') {
            result.splice(i, 1)
          } else {
            result[i] = starNode.action.replacement
          }
        }
      } else {
        for (let i = 0; i < result.length; i++) {
          const item = result[i]
          const projected = projectValue(item, starNode, seen)
          if (projected !== item) {
            if (result === value) {
              result = value.slice()
            }
            result[i] = projected
          }
        }
      }
    }

    for (const [segment, child] of node.children) {
      if (segment === '*') {
        continue
      }
      if (Array.isArray(result)) {
        if (!isArrayIndex(segment)) {
          continue
        }
        const index = Number(segment)
        if (index >= result.length) {
          continue
        }
        if (child.action !== null) {
          if (result === value) {
            result = value.slice()
          }
          if (child.action.type === 'remove') {
            result.splice(index, 1)
          } else {
            result[index] = child.action.replacement
          }
        } else {
          const item = result[index]
          const projected = projectValue(item, child, seen)
          if (projected !== item) {
            if (result === value) {
              result = value.slice()
            }
            result[index] = projected
          }
        }
        continue
      }

      if (!Object.prototype.hasOwnProperty.call(result, segment)) {
        continue
      }
      if (child.action !== null) {
        if (result === value) {
          result = { ...value }
        }
        if (child.action.type === 'remove') {
          delete result[segment]
        } else {
          result[segment] = child.action.replacement
        }
      } else {
        const item = result[segment]
        const projected = projectValue(item, child, seen)
        if (projected !== item) {
          if (result === value) {
            result = { ...value }
          }
          result[segment] = projected
        }
      }
    }

    return result
  } finally {
    seen.delete(value)
  }
}

module.exports = {
  normalizeProjectionConfig,
  compileProjection,
  selectProjectionTree,
  applyProjection
}
