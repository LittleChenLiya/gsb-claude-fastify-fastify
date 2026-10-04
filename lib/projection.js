'use strict'

const { kSchemaProjection } = require('./symbols')
const ContentType = require('./content-type')
const {
  FST_ERR_SCH_PROJECTION_BUILD,
  FST_ERR_SCH_PROJECTION_AMBIGUOUS
} = require('./errors')

// JSON Schema annotation keyword used to mark a property (or array item) as
// sensitive in a response schema. It is ignored by the serializer compiler and
// by ajv for response schemas, but it drives the response projection.
const SENSITIVE_KEYWORD = 'x-sensitive'

// Sentinel returned by the projection when a sensitive value must be removed.
const DELETE = Symbol('fastify.projection.delete')

function createNode () {
  return {
    sensitive: false,
    replace: undefined,
    hasSensitive: false,
    props: null,
    patterns: null,
    wildcard: null,
    items: null
  }
}

function markSensitive (node, replace) {
  node.sensitive = true
  if (replace !== undefined) {
    node.replace = replace
  }
}

function mergeNode (target, source) {
  if (source == null || source === target) {
    return target
  }
  if (source.sensitive) {
    if (target.sensitive && target.replace !== source.replace) {
      throw new FST_ERR_SCH_PROJECTION_BUILD('conflicting replacement values for the same sensitive path')
    }
    target.sensitive = true
    if (source.replace !== undefined) {
      target.replace = source.replace
    }
  }
  if (source.props !== null) {
    if (target.props === null) {
      target.props = new Map()
    }
    for (const [key, child] of source.props) {
      if (target.props.has(key)) {
        mergeNode(target.props.get(key), child)
      } else {
        target.props.set(key, child)
      }
    }
  }
  if (source.patterns !== null) {
    if (target.patterns === null) {
      target.patterns = []
    }
    target.patterns.push(...source.patterns)
  }
  if (source.wildcard !== null) {
    if (target.wildcard === null) {
      target.wildcard = createNode()
    }
    mergeNode(target.wildcard, source.wildcard)
  }
  if (source.items !== null) {
    if (target.items === null) {
      target.items = createNode()
    }
    mergeNode(target.items, source.items)
  }
  return target
}

function navigatePath (root, path) {
  if (path === '') {
    return root
  }
  const parts = path.split('/').filter(part => part.length > 0).map(decodeURIComponent)
  let current = root
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return null
    }
    current = current[part]
  }
  return current == null ? null : current
}

function resolveRef (ref, ctx) {
  if (typeof ref !== 'string') {
    return null
  }
  const hashIndex = ref.indexOf('#')
  if (hashIndex === 0) {
    return navigatePath(ctx.root, ref.slice(1))
  }
  if (hashIndex === -1) {
    return ctx.bucket?.[ref] ?? null
  }
  const base = ref.slice(0, hashIndex)
  const path = ref.slice(hashIndex + 1)
  const baseSchema = ctx.bucket?.[base]
  if (baseSchema == null) {
    return null
  }
  return navigatePath(baseSchema, path)
}

function isSchemaObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function branchContext (ctx) {
  return {
    root: ctx.root,
    bucket: ctx.bucket,
    strategy: ctx.strategy,
    memo: new Map(),
    foundSensitive: false
  }
}

/**
 * Walks a (sub)schema and merges its sensitive paths into `node`.
 *
 * The walk is memoized by schema object identity so that circular `$ref`s
 * (e.g. recursive tree nodes) terminate and share the same plan node.
 *
 * In "strict" strategy (default), sensitive fields found inside ambiguous
 * branches (oneOf/anyOf/if/then/else/not/dependentSchemas/contains) cause a
 * build error: the branch cannot be guessed without risking a leak.
 * In "union" strategy every branch is merged, which may over-redact but never
 * leaks.
 */
function walkSchema (schema, node, ctx) {
  if (schema === true) {
    return
  }
  if (schema === false) {
    // A `false` subschema allows no value at all: fail closed and project
    // whatever value is present.
    if (node.wildcard === null) {
      node.wildcard = createNode()
    }
    markSensitive(node.wildcard)
    ctx.foundSensitive = true
    return
  }
  if (!isSchemaObject(schema)) {
    return
  }

  const cached = ctx.memo.get(schema)
  if (cached !== undefined) {
    mergeNode(node, cached)
    return
  }
  ctx.memo.set(schema, node)

  // JSON Schema allows siblings next to $ref since draft 2019-09; the ref
  // target is walked first, then siblings are merged on top.
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, ctx)
    if (target != null) {
      walkSchema(target, node, ctx)
    }
  }

  const sensitive = schema[SENSITIVE_KEYWORD]
  if (sensitive === true || isSchemaObject(sensitive)) {
    markSensitive(node, sensitive === true ? undefined : sensitive.replace)
    ctx.foundSensitive = true
  }

  if (
    schema.type === 'array' ||
    'items' in schema ||
    'prefixItems' in schema ||
    'contains' in schema ||
    'unevaluatedItems' in schema
  ) {
    const itemSchemas = []
    if (schema.items != null) {
      if (Array.isArray(schema.items)) {
        itemSchemas.push(...schema.items)
      } else {
        itemSchemas.push(schema.items)
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      itemSchemas.push(...schema.prefixItems)
    }
    for (const itemSchema of itemSchemas) {
      const child = createNode()
      walkSchema(itemSchema, child, ctx)
      node.items = mergeNode(node.items ?? createNode(), child)
    }

    if (schema.contains != null) {
      if (ctx.strategy === 'strict') {
        const branchCtx = branchContext(ctx)
        walkSchema(schema.contains, createNode(), branchCtx)
        if (branchCtx.foundSensitive) {
          throw new FST_ERR_SCH_PROJECTION_AMBIGUOUS(ctx.method, ctx.url, 'contains')
        }
      }
      const child = createNode()
      walkSchema(schema.contains, child, ctx)
      node.items = mergeNode(node.items ?? createNode(), child)
    }

    if (schema.unevaluatedItems != null && isSchemaObject(schema.unevaluatedItems)) {
      const child = createNode()
      walkSchema(schema.unevaluatedItems, child, ctx)
      node.items = mergeNode(node.items ?? createNode(), child)
    }
  }

  if (
    schema.type === 'object' ||
    'properties' in schema ||
    'patternProperties' in schema ||
    'additionalProperties' in schema ||
    'unevaluatedProperties' in schema
  ) {
    if (isSchemaObject(schema.properties)) {
      if (node.props === null) {
        node.props = new Map()
      }
      for (const [name, propSchema] of Object.entries(schema.properties)) {
        const child = createNode()
        walkSchema(propSchema, child, ctx)
        if (node.props.has(name)) {
          mergeNode(node.props.get(name), child)
        } else {
          node.props.set(name, child)
        }
      }
    }

    if (isSchemaObject(schema.patternProperties)) {
      if (node.patterns === null) {
        node.patterns = []
      }
      for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
        const child = createNode()
        walkSchema(propSchema, child, ctx)
        node.patterns.push({ re: new RegExp(pattern), node: child })
      }
    }

    if (schema.additionalProperties != null) {
      if (schema.additionalProperties !== false && schema.additionalProperties !== true) {
        const child = createNode()
        walkSchema(schema.additionalProperties, child, ctx)
        node.wildcard = mergeNode(node.wildcard ?? createNode(), child)
      }
    }

    if (schema.unevaluatedProperties != null && isSchemaObject(schema.unevaluatedProperties)) {
      const child = createNode()
      walkSchema(schema.unevaluatedProperties, child, ctx)
      node.wildcard = mergeNode(node.wildcard ?? createNode(), child)
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      walkSchema(branch, node, ctx)
    }
  }

  const branchSchemas = []
  if (Array.isArray(schema.oneOf)) {
    branchSchemas.push(...schema.oneOf)
  }
  if (Array.isArray(schema.anyOf)) {
    branchSchemas.push(...schema.anyOf)
  }
  if (branchSchemas.length > 0) {
    if (ctx.strategy === 'strict') {
      for (const branch of branchSchemas) {
        const branchCtx = branchContext(ctx)
        walkSchema(branch, createNode(), branchCtx)
        if (branchCtx.foundSensitive) {
          throw new FST_ERR_SCH_PROJECTION_AMBIGUOUS(ctx.method, ctx.url, 'oneOf/anyOf')
        }
      }
    }
    for (const branch of branchSchemas) {
      walkSchema(branch, node, ctx)
    }
  }

  if (schema.if != null) {
    if (ctx.strategy === 'strict') {
      for (const keyword of ['if', 'then', 'else']) {
        if (schema[keyword] == null) {
          continue
        }
        const branchCtx = branchContext(ctx)
        walkSchema(schema[keyword], createNode(), branchCtx)
        if (branchCtx.foundSensitive) {
          throw new FST_ERR_SCH_PROJECTION_AMBIGUOUS(ctx.method, ctx.url, keyword)
        }
      }
    } else {
      for (const keyword of ['if', 'then', 'else']) {
        if (schema[keyword] == null) {
          continue
        }
        walkSchema(schema[keyword], node, ctx)
      }
    }
  }

  if (schema.not != null) {
    if (ctx.strategy === 'strict') {
      const branchCtx = branchContext(ctx)
      walkSchema(schema.not, createNode(), branchCtx)
      if (branchCtx.foundSensitive) {
        throw new FST_ERR_SCH_PROJECTION_AMBIGUOUS(ctx.method, ctx.url, 'not')
      }
    } else {
      walkSchema(schema.not, node, ctx)
    }
  }

  if (isSchemaObject(schema.dependentSchemas)) {
    for (const depSchema of Object.values(schema.dependentSchemas)) {
      walkConditional(depSchema, node, ctx, 'dependentSchemas')
    }
  }

  if (isSchemaObject(schema.dependencies)) {
    for (const dep of Object.values(schema.dependencies)) {
      if (Array.isArray(dep)) {
        // property dependency, not a subschema
        continue
      }
      walkConditional(dep, node, ctx, 'dependencies')
    }
  }
}

function walkConditional (schema, node, ctx, keyword) {
  if (ctx.strategy === 'strict') {
    const branchCtx = branchContext(ctx)
    walkSchema(schema, createNode(), branchCtx)
    if (branchCtx.foundSensitive) {
      throw new FST_ERR_SCH_PROJECTION_AMBIGUOUS(ctx.method, ctx.url, keyword)
    }
  } else {
    walkSchema(schema, node, ctx)
  }
}

function parsePathRule (rule) {
  const path = typeof rule === 'string' ? rule : rule?.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new FST_ERR_SCH_PROJECTION_BUILD('sensitive path rule must be a non-empty string')
  }
  const segments = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') {
      i++
      continue
    }
    if (path[i] === '[') {
      if (path[i + 1] === '*' && path[i + 2] === ']') {
        segments.push('[*]')
        i += 3
        continue
      }
      throw new FST_ERR_SCH_PROJECTION_BUILD(`invalid sensitive path rule "${path}"`)
    }
    let j = i
    while (j < path.length && path[j] !== '.' && path[j] !== '[') {
      j++
    }
    const name = path.slice(i, j)
    if (name.length === 0) {
      throw new FST_ERR_SCH_PROJECTION_BUILD(`invalid sensitive path rule "${path}"`)
    }
    segments.push(name)
    i = j
  }
  if (segments.length === 0) {
    throw new FST_ERR_SCH_PROJECTION_BUILD(`invalid sensitive path rule "${path}"`)
  }
  return { segments, replace: typeof rule === 'string' ? undefined : rule.replace }
}

function applyPathRules (root, rules, ctx) {
  for (const rule of rules) {
    const { segments, replace } = parsePathRule(rule)
    let node = root
    for (const segment of segments) {
      if (segment === '[*]') {
        if (node.items === null) {
          node.items = createNode()
        }
        node = node.items
      } else {
        if (node.props === null) {
          node.props = new Map()
        }
        if (!node.props.has(segment)) {
          node.props.set(segment, createNode())
        }
        node = node.props.get(segment)
      }
    }
    markSensitive(node, replace)
    ctx.foundSensitive = true
  }
}

function finalize (node, seen) {
  if (node == null || seen.has(node)) {
    return false
  }
  seen.add(node)
  let hasSensitive = node.sensitive
  if (node.props !== null) {
    for (const child of node.props.values()) {
      hasSensitive = finalize(child, seen) || hasSensitive
    }
  }
  if (node.patterns !== null) {
    for (const pattern of node.patterns) {
      hasSensitive = finalize(pattern.node, seen) || hasSensitive
    }
  }
  if (node.wildcard !== null) {
    hasSensitive = finalize(node.wildcard, seen) || hasSensitive
  }
  if (node.items !== null) {
    hasSensitive = finalize(node.items, seen) || hasSensitive
  }
  node.hasSensitive = hasSensitive
  return hasSensitive
}

function buildOnePlan (schema, sharedCtx) {
  const ctx = {
    root: schema,
    bucket: sharedCtx.bucket,
    strategy: sharedCtx.strategy,
    method: sharedCtx.method,
    url: sharedCtx.url,
    memo: new Map(),
    foundSensitive: false
  }
  const node = createNode()
  walkSchema(schema, node, ctx)
  if (!ctx.foundSensitive) {
    return null
  }
  finalize(node, new Set())
  return node
}

/**
 * Builds the projection plans for a route.
 *
 * @param {object} responseSchemas the route `schema.response` object
 * @param {object} options
 * @param {Array}  [options.rules] explicit sensitive path rules
 * @param {string} [options.strategy] "strict" (default) or "union"
 * @param {object} [options.bucket] shared schemas used to resolve external $refs
 * @param {string} [options.method] route method, used in error messages
 * @param {string} [options.url] route url, used in error messages
 * @returns {{ byStatus: Map, base: object, hasSensitive: boolean }}
 */
function buildProjection (responseSchemas, options = {}) {
  const sharedCtx = {
    bucket: options.bucket ?? null,
    strategy: options.strategy === 'union' ? 'union' : 'strict',
    method: options.method ?? '',
    url: options.url ?? ''
  }

  const base = createNode()
  const baseCtx = { foundSensitive: false }
  if (Array.isArray(options.rules)) {
    applyPathRules(base, options.rules, baseCtx)
  }
  finalize(base, new Set())

  const byStatus = new Map()
  let hasSensitive = baseCtx.foundSensitive

  const mergeIntoPlan = (plan) => {
    // Explicit path rules always apply, on top of the schema-derived plan.
    mergeNode(plan, base)
    finalize(plan, new Set())
    if (plan.hasSensitive) {
      hasSensitive = true
    }
    return plan
  }

  for (const [statusCode, schemaDef] of Object.entries(responseSchemas)) {
    const code = statusCode.toLowerCase()
    if (schemaDef != null && typeof schemaDef === 'object' && schemaDef.content != null) {
      const mediaMap = new Map()
      for (const [mediaName, mediaDef] of Object.entries(schemaDef.content)) {
        const plan = mergeIntoPlan(buildOnePlan(mediaDef.schema, sharedCtx) ?? createNode())
        mediaMap.set(mediaName, plan)
      }
      byStatus.set(code, mediaMap)
    } else {
      const plan = mergeIntoPlan(buildOnePlan(schemaDef, sharedCtx) ?? createNode())
      byStatus.set(code, plan)
    }
  }

  return { byStatus, base, hasSensitive }
}

function getProjectionPlan (context, statusCode, contentType) {
  const store = context[kSchemaProjection]
  if (store == null) {
    return null
  }
  const code = String(statusCode)
  let entry = store.byStatus.get(code)
  if (entry === undefined) {
    entry = store.byStatus.get(code[0] + 'xx')
  }
  if (entry === undefined) {
    entry = store.byStatus.get('default')
  }
  if (entry instanceof Map) {
    const ct = ContentType.from(contentType)
    if (ct.isValid) {
      const media = entry.get(ct.mediaType) ?? entry.get('*/*')
      if (media !== undefined) {
        return media
      }
    }
    return store.base
  }
  return entry ?? store.base
}

function isPlainObject (value) {
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function cloneDeep (value, seen) {
  if (value === null || typeof value !== 'object') {
    return value
  }
  const cached = seen.get(value)
  if (cached !== undefined) {
    return cached
  }
  if (Array.isArray(value)) {
    return projectArray(value, null, seen)
  }
  if (isPlainObject(value)) {
    return projectObject(value, null, seen)
  }
  // Buffers, Dates and other non-plain objects are passed through as-is,
  // matching the behavior of the serializer compiler.
  return value
}

function resolveChild (node, key) {
  if (node.props !== null && node.props.has(key)) {
    return node.props.get(key)
  }
  if (node.patterns !== null) {
    for (let i = 0; i < node.patterns.length; i++) {
      if (node.patterns[i].re.test(key)) {
        return node.patterns[i].node
      }
    }
  }
  if (node.wildcard !== null) {
    return node.wildcard
  }
  return null
}

function projectValue (value, node, seen) {
  if (node === null) {
    return cloneDeep(value, seen)
  }
  if (node.sensitive) {
    if (node.replace === undefined) {
      return DELETE
    }
    return cloneDeep(node.replace, new WeakMap())
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return projectArray(value, node, seen)
  }
  return projectObject(value, node, seen)
}

function projectObject (obj, node, seen) {
  const cached = seen.get(obj)
  if (cached !== undefined) {
    return cached
  }
  const clone = {}
  seen.set(obj, clone)
  const keys = Reflect.ownKeys(obj)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const child = node === null ? null : resolveChild(node, key)
    const value = projectValue(obj[key], child, seen)
    if (value !== DELETE && value !== undefined) {
      clone[key] = value
    }
  }
  return clone
}

function projectArray (arr, node, seen) {
  const cached = seen.get(arr)
  if (cached !== undefined) {
    return cached
  }
  const clone = []
  seen.set(arr, clone)
  const itemNode = node === null ? null : node.items
  for (let i = 0; i < arr.length; i++) {
    const value = projectValue(arr[i], itemNode, seen)
    if (value === DELETE || value === undefined) {
      // Keep the array length stable: JSON serialization renders holes as null.
      clone.push(null)
    } else {
      clone.push(value)
    }
  }
  return clone
}

/**
 * Returns a deep-cloned copy of `payload` where every sensitive field has been
 * removed (or replaced). The original payload is never mutated. Cycles in the
 * payload are preserved in the clone and do not cause infinite loops.
 */
function projectPayload (payload, plan) {
  if (plan == null || plan.hasSensitive !== true) {
    return payload
  }
  return projectValue(payload, plan, new WeakMap())
}

/**
 * Applies the projection for the current reply status code and content type.
 * Returns the original payload untouched when no projection applies.
 */
function applyProjection (context, payload, statusCode, contentType) {
  const plan = getProjectionPlan(context, statusCode, contentType)
  return projectPayload(payload, plan)
}

module.exports = {
  buildProjection,
  getProjectionPlan,
  projectPayload,
  applyProjection,
  // internals exposed for tests
  parsePathRule,
  walkSchema,
  createNode,
  mergeNode,
  SENSITIVE_KEYWORD
}
