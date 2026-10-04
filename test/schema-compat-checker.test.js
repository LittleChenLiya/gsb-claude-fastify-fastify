'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { checkSchemaCompatibility } = require('../lib/schema-compat-checker')
const { buildSchemaController } = require('../lib/schema-controller')

// Build an independent validator pair the same way a Fastify instance
// would, to re-verify the counterexamples reported by the checker.
function independentValidators (oldSchema, newSchema, refs = []) {
  const schemaController = buildSchemaController(null, undefined)
  for (const schema of refs) schemaController.add(schema)
  schemaController.setupValidator({ ajv: { customOptions: {}, plugins: [] } })
  const compiler = schemaController.getValidatorCompiler()
  return {
    validateOld: compiler({ schema: JSON.parse(JSON.stringify(oldSchema)) }),
    validateNew: compiler({ schema: JSON.parse(JSON.stringify(newSchema)) })
  }
}

function deepFreeze (value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

test('required narrowing: generates an object missing the now-required key', t => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.ok(result.counterexamples.length >= 1)
  const { input } = result.counterexamples[0]
  assert.ok(!Object.prototype.hasOwnProperty.call(input, 'name'))

  // Re-verify with an independent Fastify-configured validator pair.
  const { validateOld, validateNew } = independentValidators(oldSchema, newSchema)
  assert.strictEqual(validateOld(JSON.parse(JSON.stringify(input))), true)
  assert.strictEqual(validateNew(JSON.parse(JSON.stringify(input))), false)
})

test('enum narrowing [a,b] -> [a]: reports "b"', t => {
  const oldSchema = { type: 'string', enum: ['a', 'b'] }
  const newSchema = { type: 'string', enum: ['a'] }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.deepStrictEqual(result.counterexamples.map(c => c.input), ['b'])

  const { validateOld, validateNew } = independentValidators(oldSchema, newSchema)
  assert.strictEqual(validateOld('b'), true)
  assert.strictEqual(validateNew('b'), false)
})

test('enum narrowing nested in an object property', t => {
  const oldSchema = { type: 'object', properties: { role: { type: 'string', enum: ['admin', 'user'] } } }
  const newSchema = { type: 'object', properties: { role: { type: 'string', enum: ['user'] } } }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { role: 'admin' })
  assert.strictEqual(result.counterexamples[0].path, '/role')
})

test('unsupported composition keywords yield unknown, never compatible', t => {
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'not']) {
    const result = checkSchemaCompatibility({
      oldSchema: { type: 'string' },
      newSchema: { [keyword]: [{ type: 'string' }] }
    })
    assert.strictEqual(result.status, 'unknown', keyword)
    assert.strictEqual(result.counterexamples.length, 0)
    assert.ok(result.unknowns.some(u => u.keyword === keyword))
  }
})

test('other unsupported keywords (pattern, format, items) yield unknown', t => {
  const result = checkSchemaCompatibility({
    oldSchema: { type: 'string', pattern: '^a' },
    newSchema: { type: 'string', pattern: '^ab' }
  })
  assert.strictEqual(result.status, 'unknown')
  assert.ok(result.unknowns.some(u => u.keyword === 'pattern'))
})

test('$ref is resolved against registered schemas', t => {
  const refs = [
    { $id: 'OldBody', type: 'object', properties: { color: { type: 'string', enum: ['red', 'blue'] } } },
    { $id: 'NewBody', type: 'object', properties: { color: { type: 'string', enum: ['red'] } } }
  ]
  const oldSchema = { $ref: 'OldBody#' }
  const newSchema = { $ref: 'NewBody#' }

  const result = checkSchemaCompatibility({ oldSchema, newSchema, refs })

  assert.strictEqual(result.status, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { color: 'blue' })

  const { validateOld, validateNew } = independentValidators(oldSchema, newSchema, refs)
  assert.strictEqual(validateOld({ color: 'blue' }), true)
  assert.strictEqual(validateNew({ color: 'blue' }), false)
})

test('$ref to a pointer inside a registered schema', t => {
  const refs = [
    { $id: 'Common', definitions: { level: { type: 'integer', minimum: 1, maximum: 10 } } }
  ]
  const oldSchema = { $ref: 'Common#/definitions/level' }
  const newSchema = { type: 'integer', minimum: 5, maximum: 10 }

  const result = checkSchemaCompatibility({ oldSchema, newSchema, refs })

  assert.strictEqual(result.status, 'incompatible')
  assert.ok(result.counterexamples.some(c => c.input === 1))
})

test('unresolvable $ref yields unknown', t => {
  const result = checkSchemaCompatibility({
    oldSchema: { $ref: 'Missing#' },
    newSchema: { type: 'string' }
  })
  assert.strictEqual(result.status, 'unknown')
  assert.ok(result.unknowns.some(u => u.keyword === '$ref'))
})

test('numeric bounds: raised minimum and lowered maximum', t => {
  const oldSchema = { type: 'integer', minimum: 0, maximum: 100 }
  const newSchema = { type: 'integer', minimum: 10, maximum: 50 }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  const inputs = result.counterexamples.map(c => c.input)
  assert.ok(inputs.includes(0), 'expected a counterexample below the new minimum')
  assert.ok(inputs.includes(100), 'expected a counterexample above the new maximum')

  const { validateOld, validateNew } = independentValidators(oldSchema, newSchema)
  for (const c of result.counterexamples) {
    assert.strictEqual(validateOld(c.input), true)
    assert.strictEqual(validateNew(c.input), false)
  }
})

test('numeric bounds: exclusiveMinimum narrowing', t => {
  const oldSchema = { type: 'integer', exclusiveMinimum: 5 }
  const newSchema = { type: 'integer', minimum: 10 }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.ok(result.counterexamples.some(c => c.input === 6))
})

test('numeric bounds nested in object properties', t => {
  const oldSchema = { type: 'object', properties: { age: { type: 'number', minimum: 0 } } }
  const newSchema = { type: 'object', properties: { age: { type: 'number', minimum: 18 } } }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { age: 0 })
})

test('additionalProperties narrowing to false (removeAdditional disabled)', t => {
  const oldSchema = { type: 'object', properties: { a: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }
  // Fastify's default ajv config sets removeAdditional: true, which would
  // strip the extra key instead of rejecting it, so mirror an app that
  // disables it.
  const fastifyOptions = { ajv: { customOptions: { removeAdditional: false } } }

  const result = checkSchemaCompatibility({ oldSchema, newSchema, fastifyOptions })

  assert.strictEqual(result.status, 'incompatible')
  assert.ok(Object.keys(result.counterexamples[0].input).length > 0)
  assert.ok(!Object.prototype.hasOwnProperty.call(result.counterexamples[0].input, 'a') ||
    typeof result.counterexamples[0].input.a === 'string')
})

test('additionalProperties narrowing with default removeAdditional is not claimed incompatible', t => {
  const oldSchema = { type: 'object', properties: { a: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }

  // Fastify's default ajv config removes additional properties instead of
  // rejecting them, so the candidate cannot be confirmed and the result
  // must be unknown rather than a false incompatibility claim.
  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'unknown')
  assert.deepStrictEqual(result.counterexamples, [])
})

test('identical schemas are compatible', t => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
    required: ['name']
  }
  const result = checkSchemaCompatibility({ oldSchema: schema, newSchema: schema })
  assert.strictEqual(result.status, 'compatible')
  assert.deepStrictEqual(result.counterexamples, [])
  assert.deepStrictEqual(result.unknowns, [])
})

test('coercion trap: number->string is coerced by the Fastify ajv config, so no counterexample is claimed', t => {
  const result = checkSchemaCompatibility({
    oldSchema: { type: ['number', 'string'] },
    newSchema: { type: 'string' }
  })
  // ajv coerceTypes turns 5 into "5", which the new schema accepts: the
  // candidate cannot be confirmed, so the result must be unknown, never
  // a false "incompatible" nor a sampled "compatible".
  assert.strictEqual(result.status, 'unknown')
  assert.deepStrictEqual(result.counterexamples, [])
})

test('querystring style schema with required narrowing', t => {
  const oldSchema = { type: 'object', properties: { n: { type: 'integer' } } }
  const newSchema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, {})
})

test('validators run on isolated copies: frozen schemas and inputs stay untouched', t => {
  const oldSchema = deepFreeze({
    type: 'object',
    properties: {
      n: { type: 'integer' },
      tag: { type: 'string', default: 'filled-by-ajv' }
    },
    required: ['n']
  })
  const newSchema = deepFreeze({
    type: 'object',
    properties: {
      n: { type: 'integer' },
      tag: { type: 'string', default: 'filled-by-ajv' },
      name: { type: 'string' }
    },
    required: ['n', 'name']
  })
  const oldSnapshot = JSON.stringify(oldSchema)
  const newSnapshot = JSON.stringify(newSchema)

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  const { input } = result.counterexamples[0]
  // The reported input must not carry ajv coercion results or defaults:
  // validation happened on isolated deep copies.
  assert.deepStrictEqual(input, { n: 0 })
  assert.ok(!Object.prototype.hasOwnProperty.call(input, 'tag'))
  // The caller's schemas were not mutated (they are deeply frozen and
  // their snapshots are unchanged).
  assert.strictEqual(JSON.stringify(oldSchema), oldSnapshot)
  assert.strictEqual(JSON.stringify(newSchema), newSnapshot)
})

test('coercion does not leak into reported inputs', t => {
  const oldSchema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
  const newSchema = {
    type: 'object',
    properties: { n: { type: 'integer' }, extra: { type: 'string', enum: ['x'] } },
    required: ['n', 'extra']
  }

  const result = checkSchemaCompatibility({ oldSchema, newSchema })

  assert.strictEqual(result.status, 'incompatible')
  // The counterexample that misses the now-required key must be exactly
  // the generated object: no defaults injected, no coerced values.
  const missing = result.counterexamples.find(c => !Object.prototype.hasOwnProperty.call(c.input, 'extra'))
  assert.ok(missing)
  assert.deepStrictEqual(missing.input, { n: 0 })
})

test('input validation', t => {
  assert.throws(() => checkSchemaCompatibility(), TypeError)
  assert.throws(() => checkSchemaCompatibility({ oldSchema: null, newSchema: {} }), TypeError)
  assert.throws(() => checkSchemaCompatibility({ oldSchema: {}, newSchema: {}, refs: [{}] }), TypeError)
})
