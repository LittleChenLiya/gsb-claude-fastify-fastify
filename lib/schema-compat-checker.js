'use strict'

/**
 * Offline schema compatibility checker.
 *
 * Given the old and the new JSON schema of the same route section (body,
 * querystring, params or headers), this module looks for concrete inputs
 * that the OLD schema accepts but the NEW schema rejects
 * ("counterexamples").
 *
 * Supported keywords (anything else makes the result "unknown"):
 *   - object fields: `properties`, `required`, `additionalProperties` (boolean)
 *   - scalar `type` (string, number, integer, boolean, null, object, array)
 *   - `enum` / `const`
 *   - numeric bounds: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
 *   - `$ref` resolved against the registered `refs` schemas (same way
 *     `fastify.addSchema()` registers them) and against local `#/...` pointers
 *
 * Every generated counterexample is double-checked by TWO independent
 * validators built through the Fastify schema controller (same ajv
 * configuration a Fastify instance would use). Coercion and default
 * filling performed by ajv happen on isolated deep copies: neither the
 * caller's schemas nor the candidate inputs are ever mutated.
 *
 * The result is never "compatible" unless the whole schema pair was
 * understood: unsupported keywords (allOf/anyOf/oneOf/not, pattern,
 * format, items, ...) force an "unknown" status instead of a false
 * compatibility claim.
 */

const { buildSchemaController } = require('./schema-controller')

const clone = require('rfdc')({ proto: true })

const ALL_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']

// Keywords this module understands and handles explicitly.
const HANDLED_KEYWORDS = new Set([
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  '$ref'
])

// Annotation keywords that carry no validation constraint and can be ignored.
const ANNOTATION_KEYWORDS = new Set([
  '$id', '$schema', '$comment', '$defs', 'definitions',
  'title', 'description', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly'
])

const MAX_DEPTH = 20

function deepEqual (a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false
  }
  return true
}

function asTypeSet (schema) {
  if (schema.type === undefined) return new Set(ALL_TYPES)
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type])
}

function getEnum (schema) {
  if (Array.isArray(schema.enum)) return schema.enum
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) return [schema.const]
  return undefined
}

function lowerBound (schema) {
  if (typeof schema.exclusiveMinimum === 'number') {
    if (typeof schema.minimum === 'number' && schema.minimum > schema.exclusiveMinimum) {
      return { value: schema.minimum, exclusive: false }
    }
    return { value: schema.exclusiveMinimum, exclusive: true }
  }
  if (typeof schema.minimum === 'number') {
    return { value: schema.minimum, exclusive: schema.exclusiveMinimum === true }
  }
  return null
}

function upperBound (schema) {
  if (typeof schema.exclusiveMaximum === 'number') {
    if (typeof schema.maximum === 'number' && schema.maximum < schema.exclusiveMaximum) {
      return { value: schema.maximum, exclusive: false }
    }
    return { value: schema.exclusiveMaximum, exclusive: true }
  }
  if (typeof schema.maximum === 'number') {
    return { value: schema.maximum, exclusive: schema.exclusiveMaximum === true }
  }
  return null
}

function parsePointer (pointer) {
  if (pointer === '' || pointer === '/') return []
  return pointer
    .replace(/^#/, '')
    .split('/')
    .slice(1)
    .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function resolvePointer (root, segments) {
  let current = root
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined
    current = current[segment]
  }
  return current
}

/**
 * Resolve a $ref against the local document and the registered refs.
 * Returns { schema, root } or null when it cannot be resolved.
 */
function resolveRef (ref, root, refsMap) {
  const hashIndex = ref.indexOf('#')
  const id = hashIndex === -1 ? ref : ref.slice(0, hashIndex)
  const pointer = hashIndex === -1 ? '' : ref.slice(hashIndex)
  const targetRoot = id === '' ? root : refsMap.get(id)
  if (targetRoot === undefined) return null
  const target = resolvePointer(targetRoot, parsePointer(pointer))
  if (target === undefined || typeof target === 'boolean') return null
  return { schema: target, root: targetRoot }
}

/**
 * Follow $ref chains. Returns { schema, root } or null (recording an
 * "unknown" entry) when a reference cannot be resolved or cycles.
 */
function deref (schema, root, ctx) {
  const seen = new Set()
  let current = schema
  let currentRoot = root
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) {
      addUnknown(ctx, ctx.path, '$ref', 'circular $ref "' + current.$ref + '"')
      return null
    }
    seen.add(current.$ref)
    const resolved = resolveRef(current.$ref, currentRoot, ctx.refsMap)
    if (resolved === null) {
      addUnknown(ctx, ctx.path, '$ref', 'unresolvable $ref "' + current.$ref + '"')
      return null
    }
    current = resolved.schema
    currentRoot = resolved.root
  }
  if (current === undefined || current === null) return null
  return { schema: current, root: currentRoot }
}

function addUnknown (ctx, path, keyword, reason) {
  ctx.unknowns.push({ path: formatPath(path), keyword, reason })
}

function formatPath (path) {
  return path.length === 0 ? '(root)' : '/' + path.join('/')
}

function checkUnsupportedKeywords (schema, path, ctx) {
  for (const key of Object.keys(schema)) {
    if (HANDLED_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
    addUnknown(ctx, path, key, 'keyword "' + key + '" is outside the supported scope')
  }
}

function stepFor (base, isInteger) {
  if (isInteger) return 1
  return Math.abs(base) * 1e-6 + 1e-9
}

/**
 * Best-effort construction of a value of the requested JSON type that the
 * given (already deref'd) schema accepts. Returns { ok, value }.
 */
function satisfyingValue (schema, root, type, ctx, path) {
  const enumValues = getEnum(schema)
  if (enumValues !== undefined) {
    const match = enumValues.find(v => jsonTypeOf(v) === type || (type === 'number' && jsonTypeOf(v) === 'integer'))
    if (match !== undefined) return { ok: true, value: clone(match) }
    return { ok: false }
  }

  switch (type) {
    case 'string':
      return { ok: true, value: '' }
    case 'boolean':
      return { ok: true, value: true }
    case 'null':
      return { ok: true, value: null }
    case 'array':
      return { ok: true, value: [] }
    case 'number':
    case 'integer': {
      const isInteger = type === 'integer'
      const lower = lowerBound(schema)
      const upper = upperBound(schema)
      let value
      if (lower !== null) {
        value = lower.exclusive ? lower.value + stepFor(lower.value, isInteger) : lower.value
      } else if (upper !== null) {
        value = upper.exclusive ? upper.value - stepFor(upper.value, isInteger) : upper.value
      } else {
        value = 0
      }
      if (isInteger) {
        value = lower !== null && lower.exclusive ? Math.floor(lower.value) + 1 : Math.ceil(value)
        if (upper !== null && value > upper.value) {
          value = upper.exclusive ? Math.ceil(upper.value) - 1 : Math.floor(upper.value)
        }
      }
      if (lower !== null && (value < lower.value || (value === lower.value && lower.exclusive))) return { ok: false }
      if (upper !== null && (value > upper.value || (value === upper.value && upper.exclusive))) return { ok: false }
      return { ok: true, value }
    }
    case 'object': {
      const obj = buildObjectFor(schema, root, null, ctx, path)
      return obj === null ? { ok: false } : { ok: true, value: obj }
    }
    default:
      return { ok: false }
  }
}

function jsonTypeOf (value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'object'
}

/**
 * Build an object that satisfies the (deref'd) old schema, optionally
 * excluding one key. Returns null when a required property value cannot
 * be constructed.
 */
function buildObjectFor (schema, root, excludeKey, ctx, path) {
  const obj = {}
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (key === excludeKey) continue
    const subRaw = (schema.properties && schema.properties[key]) || {}
    const resolved = deref(subRaw, root, ctx)
    if (resolved === null) return null
    const types = asTypeSet(resolved.schema)
    const type = types.has('string') ? 'string' : types.values().next().value
    const built = satisfyingValue(resolved.schema, resolved.root, type, ctx, path.concat(key))
    if (!built.ok) return null
    obj[key] = built.value
  }
  return obj
}

function pushCandidate (ctx, path, value, reason) {
  ctx.candidates.push({ path: path.slice(), value, reason })
}

function diffSchemas (oldRaw, oldRoot, newRaw, newRoot, path, ctx, depth) {
  if (depth > MAX_DEPTH) {
    addUnknown(ctx, path, '$ref', 'maximum analysis depth (' + MAX_DEPTH + ') exceeded')
    return
  }

  const previousPath = ctx.path
  ctx.path = path
  const oldResolved = deref(oldRaw, oldRoot, ctx)
  const newResolved = deref(newRaw, newRoot, ctx)
  ctx.path = previousPath
  if (oldResolved === null || newResolved === null) return

  const oldSchema = oldResolved.schema
  const newSchema = newResolved.schema

  if (oldSchema === true) return diffSchemas({}, oldRoot, newSchema, newRoot, path, ctx, depth)
  if (newSchema === true) return diffSchemas(oldSchema, oldRoot, {}, newRoot, path, ctx, depth)
  if (newSchema === false) {
    // The new schema accepts nothing: any old-valid value is a counterexample.
    const oldTypes = asTypeSet(oldSchema)
    const built = satisfyingValue(oldSchema, oldResolved.root, oldTypes.values().next().value, ctx, path)
    if (built.ok) {
      pushCandidate(ctx, path, built.value, 'new schema is `false` and rejects every input')
    } else {
      addUnknown(ctx, path, 'false', 'could not construct a value accepted by the old schema')
    }
    return
  }
  if (oldSchema === false) return // old accepts nothing: nothing can be lost

  checkUnsupportedKeywords(oldSchema, path, ctx)
  checkUnsupportedKeywords(newSchema, path, ctx)

  const oldTypes = asTypeSet(oldSchema)
  const newTypes = asTypeSet(newSchema)

  // 1. type narrowing
  for (const type of oldTypes) {
    if (newTypes.has(type)) continue
    const built = satisfyingValue(oldSchema, oldResolved.root, type, ctx, path)
    if (built.ok) {
      pushCandidate(ctx, path, built.value, 'type "' + type + '" is accepted by the old schema but not by the new one')
    } else {
      addUnknown(ctx, path, 'type', 'could not construct a "' + type + '" value accepted by the old schema')
    }
  }

  // 2. enum / const narrowing
  const oldEnum = getEnum(oldSchema)
  const newEnum = getEnum(newSchema)
  if (newEnum !== undefined) {
    if (oldEnum !== undefined) {
      for (const value of oldEnum) {
        if (!newEnum.some(v => deepEqual(v, value))) {
          pushCandidate(ctx, path, clone(value), 'value ' + JSON.stringify(value) + ' is in the old enum/const but not in the new one')
        }
      }
    } else {
      const probe = probeOutsideEnum(oldSchema, oldResolved.root, oldTypes, newTypes, newEnum, ctx, path)
      if (probe.ok) {
        pushCandidate(ctx, path, probe.value, 'the new schema restricts this input to an enum/const the old schema did not have')
      } else {
        addUnknown(ctx, path, 'enum', 'could not construct an old-valid value outside the new enum/const')
      }
    }
  }

  // 3. numeric bounds
  if ((oldTypes.has('number') || oldTypes.has('integer')) && (newTypes.has('number') || newTypes.has('integer'))) {
    diffBounds(oldSchema, newSchema, path, ctx)
  }

  // 4. object keywords
  if (oldTypes.has('object') && newTypes.has('object')) {
    diffObject(oldSchema, oldResolved.root, newSchema, newResolved.root, path, ctx, depth)
  }
}

function probeOutsideEnum (oldSchema, oldRoot, oldTypes, newTypes, newEnum, ctx, path) {
  const sharedTypes = [...oldTypes].filter(t => newTypes.has(t))
  for (const type of sharedTypes) {
    const probes = []
    const built = satisfyingValue(oldSchema, oldRoot, type, ctx, path)
    if (built.ok) probes.push(built.value)
    if (type === 'string') probes.push('', 'compat-probe', 'a', 'b', '0')
    if (type === 'number') probes.push(0, 1, -1, 0.5, 1000, -1000)
    if (type === 'integer') probes.push(0, 1, -1, 2, 1000, -1000)
    if (type === 'boolean') probes.push(true, false)
    if (type === 'null') probes.push(null)
    for (const probe of probes) {
      if (!newEnum.some(v => deepEqual(v, probe))) {
        if (type === 'number' || type === 'integer') {
          const lower = lowerBound(oldSchema)
          const upper = upperBound(oldSchema)
          if (lower !== null && (probe < lower.value || (probe === lower.value && lower.exclusive))) continue
          if (upper !== null && (probe > upper.value || (probe === upper.value && upper.exclusive))) continue
          if (type === 'integer' && !Number.isInteger(probe)) continue
        }
        return { ok: true, value: probe }
      }
    }
  }
  return { ok: false }
}

function diffBounds (oldSchema, newSchema, path, ctx) {
  const isInteger = asTypeSet(newSchema).has('integer') && !asTypeSet(newSchema).has('number')
  const oldLower = lowerBound(oldSchema)
  const newLower = lowerBound(newSchema)
  const lowerTightened = newLower !== null &&
    (oldLower === null || newLower.value > oldLower.value ||
      (newLower.value === oldLower.value && newLower.exclusive && !oldLower.exclusive))
  if (lowerTightened) {
    let value
    if (oldLower === null) {
      value = newLower.value - stepFor(newLower.value, isInteger)
    } else {
      value = oldLower.exclusive ? oldLower.value + stepFor(oldLower.value, isInteger) : oldLower.value
    }
    if (isInteger && !Number.isInteger(value)) {
      value = oldLower !== null ? Math.floor(oldLower.value) + 1 : Math.ceil(newLower.value) - 1
    }
    pushCandidate(ctx, path, value, 'the new schema raises the lower bound to ' + (newLower.exclusive ? 'exclusive ' : '') + newLower.value)
  }

  const oldUpper = upperBound(oldSchema)
  const newUpper = upperBound(newSchema)
  const upperTightened = newUpper !== null &&
    (oldUpper === null || newUpper.value < oldUpper.value ||
      (newUpper.value === oldUpper.value && newUpper.exclusive && !oldUpper.exclusive))
  if (upperTightened) {
    let value
    if (oldUpper === null) {
      value = newUpper.value + stepFor(newUpper.value, isInteger)
    } else {
      value = oldUpper.exclusive ? oldUpper.value - stepFor(oldUpper.value, isInteger) : oldUpper.value
    }
    if (isInteger && !Number.isInteger(value)) {
      value = oldUpper !== null ? Math.ceil(oldUpper.value) - 1 : Math.floor(newUpper.value) + 1
    }
    pushCandidate(ctx, path, value, 'the new schema lowers the upper bound to ' + (newUpper.exclusive ? 'exclusive ' : '') + newUpper.value)
  }
}

function diffObject (oldSchema, oldRoot, newSchema, newRoot, path, ctx, depth) {
  const oldRequired = new Set(Array.isArray(oldSchema.required) ? oldSchema.required : [])
  const newRequired = Array.isArray(newSchema.required) ? newSchema.required : []

  // required narrowing
  for (const key of newRequired) {
    if (oldRequired.has(key)) continue
    const obj = buildObjectFor(oldSchema, oldRoot, key, ctx, path)
    if (obj === null) {
      addUnknown(ctx, path, 'required', 'could not construct an old-valid object missing the now-required key "' + key + '"')
      continue
    }
    pushCandidate(ctx, path, obj, 'key "' + key + '" is required by the new schema but was optional before')
  }

  // properties recursion
  const oldProps = oldSchema.properties || {}
  const newProps = newSchema.properties || {}
  for (const key of Object.keys(newProps)) {
    const oldSub = oldProps[key]
    if (oldSub === undefined) {
      // The old schema constrained this key only through additionalProperties.
      if (oldSchema.additionalProperties === false && !oldRequired.has(key)) continue
      if (typeof oldSchema.additionalProperties === 'object' && oldSchema.additionalProperties !== null) {
        addUnknown(ctx, path.concat(key), 'additionalProperties', 'old schema constrains additional properties with a schema')
        continue
      }
      diffSchemas({}, oldRoot, newProps[key], newRoot, path.concat(key), ctx, depth + 1)
    } else {
      diffSchemas(oldSub, oldRoot, newProps[key], newRoot, path.concat(key), ctx, depth + 1)
    }
  }

  // additionalProperties narrowing
  if (newSchema.additionalProperties === false && oldSchema.additionalProperties !== false) {
    if (typeof oldSchema.additionalProperties === 'object' && oldSchema.additionalProperties !== null) {
      addUnknown(ctx, path, 'additionalProperties', 'old schema constrains additional properties with a schema')
    } else {
      let extraKey = 'additionalProp'
      while (Object.prototype.hasOwnProperty.call(newProps, extraKey)) extraKey += '_'
      const obj = buildObjectFor(oldSchema, oldRoot, null, ctx, path)
      if (obj === null) {
        addUnknown(ctx, path, 'additionalProperties', 'could not construct an old-valid object with an extra key')
      } else {
        obj[extraKey] = 0
        pushCandidate(ctx, path, obj, 'the new schema forbids additional properties such as "' + extraKey + '"')
      }
    }
  } else if (typeof newSchema.additionalProperties === 'object' && newSchema.additionalProperties !== null) {
    addUnknown(ctx, path, 'additionalProperties', 'new schema constrains additional properties with a schema')
  }
}

/**
 * Embed a candidate sub-value located at `path` inside a skeleton input
 * that the old (root) schema accepts.
 */
function materialize (schemaRaw, root, path, value, ctx) {
  const resolved = deref(schemaRaw, root, ctx)
  if (resolved === null) return { ok: false }
  if (path.length === 0) return { ok: true, value }
  const head = path[0]
  const rest = path.slice(1)
  const obj = buildObjectFor(resolved.schema, resolved.root, null, ctx, [])
  if (obj === null) return { ok: false }
  const sub = (resolved.schema.properties && resolved.schema.properties[head]) || {}
  const child = materialize(sub, resolved.root, rest, value, ctx)
  if (!child.ok) return { ok: false }
  obj[head] = child.value
  return { ok: true, value: obj }
}

/**
 * Build one independent validator compiler exactly the way a Fastify
 * instance does: a fresh schema controller, the registered schemas added
 * to its bucket and the validator set up with the (normalized) ajv
 * options. Two calls never share ajv instances.
 */
function createValidatorCompiler (refs, fastifyOptions) {
  const options = fastifyOptions || {}
  const schemaController = buildSchemaController(null, options.schemaController)
  for (const schema of refs) {
    schemaController.add(schema)
  }
  const ajv = Object.assign({ customOptions: {}, plugins: [] }, options.ajv)
  schemaController.setupValidator({ ajv })
  return schemaController.getValidatorCompiler()
}

function compilePair (refs, fastifyOptions, oldSchema, newSchema) {
  const compiler = createValidatorCompiler(refs, fastifyOptions)
  return {
    validateOld: compiler({ schema: clone(oldSchema) }),
    validateNew: compiler({ schema: clone(newSchema) })
  }
}

/**
 * Check the compatibility of a route schema upgrade.
 *
 * @param {object} args
 * @param {object} args.oldSchema the currently deployed JSON schema
 * @param {object} args.newSchema the candidate replacement JSON schema
 * @param {object[]} [args.refs] shared schemas ($id) the way they would be
 *   registered with `fastify.addSchema()`
 * @param {object} [args.fastifyOptions] subset of the Fastify server options
 *   (`ajv`, `schemaController`) to mirror the target application config
 * @returns {{ status: 'compatible'|'incompatible'|'unknown',
 *             counterexamples: Array<{path: string, input: any, reason: string}>,
 *             unknowns: Array<{path: string, keyword: string, reason: string}> }}
 */
function checkSchemaCompatibility (args) {
  if (args === null || typeof args !== 'object') {
    throw new TypeError('checkSchemaCompatibility expects an options object')
  }
  const { oldSchema, newSchema, refs = [], fastifyOptions } = args
  if (oldSchema === null || typeof oldSchema !== 'object') {
    throw new TypeError('oldSchema must be a JSON schema object')
  }
  if (newSchema === null || typeof newSchema !== 'object') {
    throw new TypeError('newSchema must be a JSON schema object')
  }
  if (!Array.isArray(refs)) {
    throw new TypeError('refs must be an array of schemas with an $id')
  }

  const refsMap = new Map()
  for (const schema of refs) {
    if (schema === null || typeof schema !== 'object' || typeof schema.$id !== 'string') {
      throw new TypeError('every refs entry must be a schema object with a string $id')
    }
    refsMap.set(schema.$id, schema)
  }

  const ctx = { refsMap, candidates: [], unknowns: [], path: [] }
  diffSchemas(oldSchema, oldSchema, newSchema, newSchema, [], ctx, 0)

  // Materialize and deduplicate candidates.
  const seen = new Set()
  const materialized = []
  for (const candidate of ctx.candidates) {
    const built = materialize(oldSchema, oldSchema, candidate.path, candidate.value, ctx)
    if (!built.ok) {
      ctx.unknowns.push({
        path: formatPath(candidate.path),
        keyword: 'candidate',
        reason: 'could not embed the candidate for "' + candidate.reason + '" into an old-valid input'
      })
      continue
    }
    const key = JSON.stringify(built.value)
    if (seen.has(key)) continue
    seen.add(key)
    materialized.push({ path: candidate.path, input: built.value, reason: candidate.reason })
  }

  // Double-check every candidate with two independent validators built
  // through the Fastify schema controller. Validation always runs on deep
  // copies so that ajv coercion/default filling cannot mutate the
  // caller's schemas or the reported inputs.
  let pairA
  let pairB
  try {
    pairA = compilePair(refs, fastifyOptions, oldSchema, newSchema)
    pairB = compilePair(refs, fastifyOptions, oldSchema, newSchema)
  } catch (err) {
    ctx.unknowns.push({ path: '(root)', keyword: 'compile', reason: 'schema compilation failed: ' + err.message })
    return buildResult([], ctx.unknowns)
  }

  const counterexamples = []
  for (const candidate of materialized) {
    const results = [pairA, pairB].map(pair => ({
      oldValid: pair.validateOld(clone(candidate.input)),
      newValid: pair.validateNew(clone(candidate.input))
    }))
    const confirmed = results.every(r => r.oldValid === true && r.newValid === false)
    if (confirmed) {
      counterexamples.push({
        path: formatPath(candidate.path),
        input: candidate.input,
        reason: candidate.reason
      })
    } else {
      ctx.unknowns.push({
        path: formatPath(candidate.path),
        keyword: 'candidate',
        reason: 'candidate for "' + candidate.reason + '" was not confirmed by the Fastify validators ' +
          '(results: ' + results.map(r => 'old=' + r.oldValid + ',new=' + r.newValid).join(' / ') + ')'
      })
    }
  }

  return buildResult(counterexamples, ctx.unknowns)
}

function buildResult (counterexamples, unknowns) {
  const status = counterexamples.length > 0
    ? 'incompatible'
    : (unknowns.length > 0 ? 'unknown' : 'compatible')
  return { status, counterexamples, unknowns }
}

module.exports = { checkSchemaCompatibility }
