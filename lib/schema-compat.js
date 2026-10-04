'use strict'

const rfdc = require('rfdc')
const createAjvCompiler = require('@fastify/ajv-compiler')

const clone = rfdc()

// Keywords this module knows how to reason about. Anything else reachable in a
// schema (through $ref) makes the result 'unknown' — we never claim compatibility
// we cannot prove. See docs/schema-compat.md for the supported scope.
const ALLOWED_KEYWORDS = new Set([
  // schema metadata / annotations
  '$id', '$schema', '$defs', 'definitions', 'title', 'description',
  'default', 'examples', '$comment', 'nullable',
  // structure
  'type', 'properties', 'required', 'additionalProperties', 'items',
  // values
  'enum', 'const',
  // numeric bounds
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'
])

/**
 * Offline compatibility check for two request JSON Schemas (old vs new) of the
 * same route. It finds concrete inputs the old schema accepts but the new one
 * rejects, within the supported keyword scope. Unsupported keywords (combinators
 * etc.) and unresolvable $refs yield an 'unknown' verdict — never a clean bill
 * of health.
 *
 * Every candidate input is re-checked with two independent validators built with
 * the Fastify ajv compiler (coerceTypes: 'array', useDefaults: true,
 * removeAdditional: true). Coercion and default filling happen on deep clones,
 * the original schemas and inputs are never mutated.
 *
 * @param {object} oldSchema  The currently deployed request schema.
 * @param {object} newSchema  The proposed request schema.
 * @param {object} [options]
 * @param {Record<string, object>} [options.schemas]  Schemas registered on the
 *   Fastify instance (the schema bucket, keyed by $id). Used to resolve $ref.
 * @param {'body' | 'querystring'} [options.part]  Which request part the schemas
 *   describe. Only used for reporting. Defaults to 'body'.
 * @returns {{verdict: 'compatible'|'incompatible'|'unknown', part: string, [k: string]: *}}
 */
function checkSchemaCompatibility (oldSchema, newSchema, options = {}) {
  const part = options.part === 'querystring' ? 'querystring' : 'body'
  const schemas = options.schemas || {}

  const oldCtx = { schemas, root: oldSchema, baseId: oldSchema && oldSchema.$id }
  const newCtx = { schemas, root: newSchema, baseId: newSchema && newSchema.$id }

  // 1. Scope check: any keyword we cannot reason about -> unknown.
  const unsupported = []
  findUnsupported(oldSchema, oldCtx, [], unsupported, new Set())
  findUnsupported(newSchema, newCtx, [], unsupported, new Set())
  if (unsupported.length > 0) {
    return {
      verdict: 'unknown',
      part,
      reason: unsupported.some(u => u.unresolvable) ? 'unresolvable-ref' : 'unsupported-keyword',
      unsupported: dedupeUnsupported(unsupported)
    }
  }

  // 2. Structural comparison: generate candidate counterexamples.
  const candidates = []
  const compareCtx = { schemas, oldCtx, newCtx }
  compareSchemas(oldSchema, newSchema, [], compareCtx, candidates, new Set(), new Set())

  if (candidates.length === 0) {
    return { verdict: 'compatible', part }
  }

  // 3. Re-verify every candidate with two independent Fastify-config validators.
  const confirmed = []
  const unconfirmed = []
  for (const candidate of candidates) {
    const input = constructInput(candidate)
    const verification = verifyWithFastify(input, oldSchema, newSchema, schemas)
    if (verification.oldAccepts && verification.newRejects) {
      confirmed.push({
        path: pathToString(candidate.segments),
        input,
        reason: candidate.reason,
        verified: { oldAccepts: true, newRejects: true }
      })
    } else {
      unconfirmed.push({
        path: pathToString(candidate.segments),
        reason: candidate.reason,
        oldAccepts: verification.oldAccepts,
        newRejects: verification.newRejects,
        oldErrors: verification.oldErrors,
        newErrors: verification.newErrors
      })
    }
  }

  if (confirmed.length > 0) {
    return { verdict: 'incompatible', part, counterexamples: confirmed }
  }

  // Structural differences exist but every candidate was absorbed by Fastify's
  // coercion/default/removeAdditional behavior (or otherwise rejected by the
  // old validator). We cannot produce a concrete input, so do not claim success.
  return {
    verdict: 'unknown',
    part,
    reason: 'unconfirmed-divergence',
    candidates: unconfirmed
  }
}

/* ------------------------------------------------------------------ */
/* $ref resolution                                                     */
/* ------------------------------------------------------------------ */

function createContext (schemas, root) {
  return { schemas, root, baseId: root && root.$id }
}

/**
 * Follow a chain of $ref nodes to the target schema. Returns null when a ref
 * cannot be resolved. Sibling keywords of a $ref are ignored (ajv draft-7
 * behavior). Uses its own cycle guard so callers' traversal sets do not cause
 * false cycle detection.
 */
function followRefs (node, ctx) {
  let current = node
  const guard = new Set()
  while (current && typeof current === 'object' && !Array.isArray(current) && '$ref' in current) {
    if (guard.has(current)) return current
    guard.add(current)
    const resolved = resolveRef(current.$ref, ctx)
    if (!resolved) return null
    current = resolved.node
    ctx = resolved.ctx
  }
  return current
}

function resolveRef (ref, ctx) {
  if (typeof ref !== 'string') return null
  const hash = ref.indexOf('#')
  const base = hash === -1 ? ref : ref.slice(0, hash)
  const fragment = hash === -1 ? '' : ref.slice(hash + 1)

  let target
  let targetCtx
  if (base === '' || base === ctx.baseId) {
    target = ctx.root
    targetCtx = ctx
  } else if (ctx.schemas && Object.prototype.hasOwnProperty.call(ctx.schemas, base)) {
    target = ctx.schemas[base]
    targetCtx = createContext(ctx.schemas, target)
  } else {
    return null
  }

  if (fragment !== '') {
    const pointer = jsonPointer(target, fragment)
    if (pointer === null || pointer === undefined) return null
    return { node: pointer, ctx: targetCtx }
  }
  return { node: target, ctx: targetCtx }
}

// RFC 6901 JSON Pointer (fragment without the leading '#').
function jsonPointer (root, fragment) {
  if (fragment === '') return root
  if (fragment[0] !== '/') return null
  let current = root
  const parts = fragment.slice(1).split('/')
  for (const rawPart of parts) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object') return null
    current = current[part]
    if (current === undefined) return null
  }
  return current
}

/* ------------------------------------------------------------------ */
/* Unsupported keyword scan                                            */
/* ------------------------------------------------------------------ */

function findUnsupported (node, ctx, path, out, seen) {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)

  if (Array.isArray(node)) {
    for (const item of node) {
      findUnsupported(item, ctx, path, out, seen)
    }
    return
  }

  if ('$ref' in node) {
    const target = followRefs(node, ctx)
    if (target === null) {
      out.push({ keyword: '$ref', path: pathToString(path), unresolvable: true })
      return
    }
    findUnsupported(target, ctx, path, out, seen)
    return
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      out.push({ keyword: key, path: pathToString(path) })
    }
  }

  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const [prop, subschema] of Object.entries(node.properties)) {
      findUnsupported(subschema, ctx, path.concat(prop), out, seen)
    }
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      // Draft-4 tuple-form items: element-wise comparison is not supported.
      out.push({ keyword: 'items', path: pathToString(path) })
    } else {
      findUnsupported(node.items, ctx, path.concat('[]'), out, seen)
    }
  }
  for (const container of ['definitions', '$defs']) {
    const defs = node[container]
    if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
      for (const [name, subschema] of Object.entries(defs)) {
        findUnsupported(subschema, ctx, path.concat(container, name), out, seen)
      }
    }
  }
}

function dedupeUnsupported (list) {
  const seen = new Set()
  const result = []
  for (const item of list) {
    const key = item.keyword + '\u0000' + item.path
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Structural comparison                                               */
/* ------------------------------------------------------------------ */

function compareSchemas (oldNode, newNode, path, ctx, out, seenOld, seenNew) {
  const o = followRefs(oldNode, ctx.oldCtx)
  const n = followRefs(newNode, ctx.newCtx)
  if (o === null || n === null) return // unresolvable ref; already reported
  if (seenOld.has(o) || seenNew.has(n)) return // schema-graph cycle
  seenOld.add(o)
  seenNew.add(n)

  const oc = extractConstraints(o)
  const nc = extractConstraints(n)

  if (oc.rejectAll) return // old accepts nothing -> no possible counterexample
  if (nc.rejectAll) {
    const value = generateValue(oc)
    if (value !== undefined) {
      out.push(makeDivergence(path, value, 'new-rejects-all'))
    }
    return
  }

  // enum / const ---------------------------------------------------------
  const oEnum = oc.enumValues || (oc.constValue !== undefined ? [oc.constValue] : undefined)
  const nEnum = nc.enumValues || (nc.constValue !== undefined ? [nc.constValue] : undefined)
  if (oEnum) {
    for (const value of oEnum) {
      if (!valueSatisfies(value, nc)) {
        out.push(makeDivergence(path, value, 'enum-narrowed'))
        break
      }
    }
  } else if (nEnum) {
    const value = generateNotInEnum(oc, nEnum)
    if (value !== undefined) {
      out.push(makeDivergence(path, value, 'enum-narrowed'))
    }
  }

  // numeric bounds --------------------------------------------------------
  if (isNumericTyped(oc.types) && isNumericTyped(nc.types)) {
    const value = findBoundViolation(oc, nc)
    if (value !== undefined) {
      out.push(makeDivergence(path, value, 'bound-tightened'))
    }
  }

  // type changes ----------------------------------------------------------
  if (oc.types && nc.types) {
    const newTypes = new Set(nc.types)
    for (const type of oc.types) {
      if (!newTypes.has(type)) {
        const value = generateTypeValue(type, oc)
        if (value !== undefined) {
          out.push(makeDivergence(path, value, 'type-changed'))
          break
        }
      }
    }
  } else if (oc.types === undefined && nc.types) {
    // old is typeless (accepts anything), new restricts the type: find a value
    // of a type new does not accept.
    const value = generateValueNotOfTypes(new Set(nc.types), oc)
    if (value !== undefined) {
      out.push(makeDivergence(path, value, 'type-changed'))
    }
  }

  // object properties / required -----------------------------------------
  if (oc.properties || nc.properties || oc.required || nc.required) {
    const oProps = (oc.properties && typeof oc.properties === 'object') ? oc.properties : {}
    const nProps = (nc.properties && typeof nc.properties === 'object') ? nc.properties : {}
    const oRequired = new Set(Array.isArray(oc.required) ? oc.required : [])
    const nRequired = new Set(Array.isArray(nc.required) ? nc.required : [])

    for (const prop of Object.keys(nProps)) {
      if (nRequired.has(prop) && !oRequired.has(prop)) {
        // If the new property carries a default, useDefaults fills the missing
        // key before validation, so the new validator will not reject the
        // missing-key object.
        const newProp = followRefs(nProps[prop], ctx.newCtx)
        const hasDefault = newProp && typeof newProp === 'object' && !Array.isArray(newProp) && 'default' in newProp
        if (!hasDefault) {
          out.push(makeMissingKey(path, prop, 'required-added'))
        }
      }
    }
    for (const prop of Object.keys(oProps)) {
      if (Object.prototype.hasOwnProperty.call(nProps, prop)) {
        compareSchemas(oProps[prop], nProps[prop], path.concat(prop), ctx, out, seenOld, seenNew)
      }
      // Property removed in the new schema: Fastify strips additional
      // properties (removeAdditional: true) instead of rejecting them, so
      // this is not a counterexample under the Fastify config.
    }
  }

  // array items ------------------------------------------------------------
  if (oc.items && nc.items && !Array.isArray(oc.items) && !Array.isArray(nc.items)) {
    compareSchemas(oc.items, nc.items, path.concat('[]'), ctx, out, seenOld, seenNew)
  }
}

function extractConstraints (node) {
  if (node === true) return { types: undefined }
  if (node === false) return { rejectAll: true }
  const types = node.type === undefined
    ? undefined
    : (Array.isArray(node.type) ? node.type : [node.type])
  return {
    types,
    enumValues: Array.isArray(node.enum) ? node.enum : undefined,
    constValue: node.const,
    minimum: node.minimum,
    maximum: node.maximum,
    exclusiveMinimum: node.exclusiveMinimum,
    exclusiveMaximum: node.exclusiveMaximum,
    properties: node.properties,
    required: node.required,
    items: node.items,
    default: node.default
  }
}

/* ------------------------------------------------------------------ */
/* Value generation                                                    */
/* ------------------------------------------------------------------ */

function makeDivergence (segments, value, reason) {
  return { segments: segments.slice(), value, reason, missingKey: undefined }
}

function makeMissingKey (segments, missingKey, reason) {
  return { segments: segments.slice(), value: undefined, reason, missingKey }
}

function pathToString (segments) {
  let result = ''
  for (const segment of segments) {
    if (segment === '[]') result += '[]'
    else result += '.' + segment
  }
  return result.replace(/^\./, '')
}

/**
 * Build the concrete input object for a divergence. Property paths become
 * nested objects; '[]' markers wrap the following segment in a one-element
 * array; missing-key divergences omit the key at the leaf object.
 */
function constructInput (divergence) {
  const { segments, value, missingKey } = divergence
  if (segments.length === 0) {
    return missingKey ? {} : value
  }
  const root = {}
  let node = root
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === '[]') {
      // node was advanced into the first element when the array was created
      continue
    }
    const last = i === segments.length - 1
    if (last) {
      if (missingKey) {
        node[segment] = {}
      } else {
        node[segment] = value
      }
    } else if (segments[i + 1] === '[]') {
      node[segment] = [{}]
      node = node[segment][0]
    } else {
      node[segment] = {}
      node = node[segment]
    }
  }
  return root
}

function defaultValue (type) {
  switch (type) {
    case 'string': return 'string'
    case 'number':
    case 'integer': return 0
    case 'boolean': return true
    case 'null': return null
    case 'object': return {}
    case 'array': return []
    default: return undefined
  }
}

function jsType (value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function isNumericTyped (types) {
  return Array.isArray(types) && types.some(t => t === 'number' || t === 'integer')
}

function lowerBound (c) {
  const candidates = []
  if (c.minimum !== undefined) candidates.push({ value: c.minimum, exclusive: false })
  if (c.exclusiveMinimum === true && c.minimum !== undefined) {
    candidates.push({ value: c.minimum, exclusive: true })
  } else if (typeof c.exclusiveMinimum === 'number') {
    candidates.push({ value: c.exclusiveMinimum, exclusive: true })
  }
  if (candidates.length === 0) return undefined
  let bound = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (candidate.value > bound.value) bound = candidate
    else if (candidate.value === bound.value && candidate.exclusive) bound = candidate
  }
  return bound
}

function upperBound (c) {
  const candidates = []
  if (c.maximum !== undefined) candidates.push({ value: c.maximum, exclusive: false })
  if (c.exclusiveMaximum === true && c.maximum !== undefined) {
    candidates.push({ value: c.maximum, exclusive: true })
  } else if (typeof c.exclusiveMaximum === 'number') {
    candidates.push({ value: c.exclusiveMaximum, exclusive: true })
  }
  if (candidates.length === 0) return undefined
  let bound = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (candidate.value < bound.value) bound = candidate
    else if (candidate.value === bound.value && candidate.exclusive) bound = candidate
  }
  return bound
}

function valueSatisfies (value, c) {
  if (c.enumValues && !c.enumValues.includes(value)) return false
  if (c.constValue !== undefined && c.constValue !== value) return false
  if (c.types) {
    const type = jsType(value)
    const okType = c.types.includes(type) ||
      (type === 'integer' && c.types.includes('number'))
    if (!okType) return false
  }
  if (typeof value === 'number') {
    const lb = lowerBound(c)
    const ub = upperBound(c)
    if (lb) {
      if (lb.exclusive ? value <= lb.value : value < lb.value) return false
    }
    if (ub) {
      if (ub.exclusive ? value >= ub.value : value > ub.value) return false
    }
  }
  return true
}

function generateValue (c) {
  if (c.enumValues) return c.enumValues[0]
  if (c.constValue !== undefined) return c.constValue
  if (c.types) {
    for (const type of c.types) {
      const value = generateTypeValue(type, c)
      if (value !== undefined) return value
    }
    return undefined
  }
  for (const type of ['string', 'number', 'boolean', 'null', 'object', 'array']) {
    const value = defaultValue(type)
    if (valueSatisfies(value, c)) return value
  }
  return undefined
}

function generateTypeValue (type, c) {
  if (c.enumValues) {
    for (const value of c.enumValues) {
      if (jsType(value) === type || (type === 'number' && jsType(value) === 'integer')) {
        return value
      }
    }
    return undefined
  }
  if (type === 'number' || type === 'integer') {
    return numericInRange(c, type === 'integer')
  }
  const value = defaultValue(type)
  return valueSatisfies(value, c) ? value : undefined
}

function numericInRange (c, isInteger) {
  const step = isInteger ? 1 : 0.5
  const candidates = []
  const lb = lowerBound(c)
  const ub = upperBound(c)
  if (lb) candidates.push(lb.exclusive ? lb.value + step : lb.value)
  candidates.push(0, 1, -1, isInteger ? 2 : 0.5, isInteger ? -2 : -0.5)
  if (ub) candidates.push(ub.exclusive ? ub.value - step : ub.value)
  for (const value of candidates) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (isInteger && !Number.isInteger(value)) continue
    if (valueSatisfies(value, c)) return value
  }
  return undefined
}

function generateNotInEnum (c, allowedEnum) {
  const allowed = new Set(allowedEnum)
  if (c.enumValues) {
    for (const value of c.enumValues) {
      if (!allowed.has(value)) return value
    }
    return undefined
  }
  const types = c.types || ['string', 'number', 'boolean', 'null', 'object', 'array']
  for (const type of types) {
    let value
    if (type === 'number' || type === 'integer') {
      value = numericInRange(c, type === 'integer')
    } else {
      value = defaultValue(type)
    }
    if (value !== undefined && !allowed.has(value) && valueSatisfies(value, c)) {
      return value
    }
  }
  return undefined
}

function generateValueNotOfTypes (newTypes, c) {
  for (const type of ['string', 'number', 'boolean', 'null', 'object', 'array']) {
    if (newTypes.has(type)) continue
    const value = defaultValue(type)
    if (valueSatisfies(value, c)) return value
  }
  return undefined
}

/**
 * Find a numeric value the old range accepts but the new range rejects.
 */
function findBoundViolation (oldC, newC) {
  const isInteger = oldC.types.includes('integer') && !oldC.types.includes('number')
  const step = isInteger ? 1 : 0.5
  const candidates = []
  const newLower = lowerBound(newC)
  const newUpper = upperBound(newC)
  if (newLower) {
    candidates.push(newLower.value - step)
    candidates.push(newLower.value)
  }
  if (newUpper) {
    candidates.push(newUpper.value + step)
    candidates.push(newUpper.value)
  }
  const oldLower = lowerBound(oldC)
  const oldUpper = upperBound(oldC)
  if (oldLower) candidates.push(oldLower.value, oldLower.value + step)
  if (oldUpper) candidates.push(oldUpper.value, oldUpper.value - step)
  candidates.push(0, 1, -1, 0.5, -0.5)
  for (const value of candidates) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (isInteger && !Number.isInteger(value)) continue
    if (valueSatisfies(value, oldC) && !valueSatisfies(value, newC)) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Independent verification with Fastify-config validators             */
/* ------------------------------------------------------------------ */

/**
 * Re-check a candidate input with two independent validators built exactly as
 * Fastify builds them (the @fastify/ajv-compiler default options:
 * coerceTypes: 'array', useDefaults: true, removeAdditional: true).
 *
 * Coercion and default filling only touch deep clones; the input and the
 * schemas are never mutated.
 */
function verifyWithFastify (input, oldSchema, newSchema, schemas) {
  const buildOld = createAjvCompiler()
  const buildNew = createAjvCompiler()
  const oldValidate = buildOld(schemas, { customOptions: {} })({ schema: oldSchema })
  const newValidate = buildNew(schemas, { customOptions: {} })({ schema: newSchema })

  const cloneForOld = clone(input)
  const cloneForNew = clone(input)

  let oldAccepts = false
  let newRejects = false
  try {
    oldAccepts = oldValidate(cloneForOld) === true
  } catch (_) {
    oldAccepts = false
  }
  try {
    newRejects = newValidate(cloneForNew) !== true
  } catch (_) {
    newRejects = true
  }

  return {
    oldAccepts,
    newRejects,
    oldErrors: oldValidate.errors || null,
    newErrors: newValidate.errors || null
  }
}

module.exports = checkSchemaCompatibility
module.exports.checkSchemaCompatibility = checkSchemaCompatibility
module.exports.constructInput = constructInput
module.exports.pathToString = pathToString
