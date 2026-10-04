'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const rfdc = require('rfdc')

const { checkSchemaCompatibility } = require('../lib/schema-compat')

const clone = rfdc()
const fixturesDir = path.join(__dirname, 'fixtures', 'schema-compat')

/* ------------------------------------------------------------------ */
/* required-added (acceptance case 1)                                  */
/* ------------------------------------------------------------------ */

test('required-added: old optional name, new required name yields a missing-name object', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.ok(Array.isArray(result.counterexamples))
  assert.strictEqual(result.counterexamples.length, 1)
  const counterexample = result.counterexamples[0]
  assert.deepStrictEqual(counterexample.input, {})
  assert.strictEqual(counterexample.path, '')
  assert.strictEqual(counterexample.reason, 'required-added')
  assert.strictEqual(counterexample.verified.oldAccepts, true)
  assert.strictEqual(counterexample.verified.newRejects, true)
})

test('required-added nested: missing key is reported at the object path', () => {
  const oldSchema = {
    type: 'object',
    properties: {
      user: { type: 'object', properties: { name: { type: 'string' } } }
    }
  }
  const newSchema = {
    type: 'object',
    properties: {
      user: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
    }
  }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  const counterexample = result.counterexamples[0]
  assert.deepStrictEqual(counterexample.input, { user: {} })
  assert.strictEqual(counterexample.path, 'user')
})

test('required-added with a default is absorbed by useDefaults -> compatible', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', default: 'anonymous' } }
  }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'compatible')
})

/* ------------------------------------------------------------------ */
/* enum-narrowed (acceptance case 2)                                   */
/* ------------------------------------------------------------------ */

test('enum-narrowed: [a, b] -> [a] yields b', () => {
  const oldSchema = { type: 'object', properties: { color: { enum: ['a', 'b'] } } }
  const newSchema = { type: 'object', properties: { color: { enum: ['a'] } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  const counterexample = result.counterexamples[0]
  assert.deepStrictEqual(counterexample.input, { color: 'b' })
  assert.strictEqual(counterexample.reason, 'enum-narrowed')
  assert.strictEqual(counterexample.verified.oldAccepts, true)
  assert.strictEqual(counterexample.verified.newRejects, true)
})

test('enum-narrowed with numbers yields the dropped number', () => {
  const oldSchema = { type: 'object', properties: { code: { enum: [200, 201, 204] } } }
  const newSchema = { type: 'object', properties: { code: { enum: [200] } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { code: 201 })
})

test('enum unchanged is compatible', () => {
  const schema = { type: 'object', properties: { color: { enum: ['a', 'b'] } } }
  const result = checkSchemaCompatibility(schema, schema)
  assert.strictEqual(result.verdict, 'compatible')
})

/* ------------------------------------------------------------------ */
/* $ref (acceptance case 3)                                            */
/* ------------------------------------------------------------------ */

test('$ref resolves registered schemas and detects nested required-added', () => {
  const schemas = {
    'http://example.com/user-v1': {
      $id: 'http://example.com/user-v1',
      type: 'object',
      properties: { name: { type: 'string' } }
    },
    'http://example.com/user-v2': {
      $id: 'http://example.com/user-v2',
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } }
    }
  }
  const oldSchema = { type: 'object', properties: { user: { $ref: 'http://example.com/user-v1' } } }
  const newSchema = { type: 'object', properties: { user: { $ref: 'http://example.com/user-v2' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema, { schemas })

  assert.strictEqual(result.verdict, 'incompatible')
  const counterexample = result.counterexamples[0]
  assert.deepStrictEqual(counterexample.input, { user: {} })
  assert.strictEqual(counterexample.path, 'user')
  assert.strictEqual(counterexample.verified.oldAccepts, true)
  assert.strictEqual(counterexample.verified.newRejects, true)
})

test('$ref to an unregistered schema returns unknown, not compatible', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { user: { $ref: 'http://example.com/missing' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'unknown')
  assert.strictEqual(result.reason, 'unresolvable-ref')
  assert.ok(result.unsupported.some(u => u.keyword === '$ref' && u.unresolvable))
})

test('$ref with a JSON Pointer fragment resolves into the target schema', () => {
  const schemas = {
    'http://example.com/defs': {
      $id: 'http://example.com/defs',
      definitions: {
        name: { type: 'string' }
      }
    }
  }
  const oldSchema = { type: 'object', properties: { name: { $ref: 'http://example.com/defs#/definitions/name' } } }
  const newSchema = { type: 'object', required: ['name'], properties: { name: { $ref: 'http://example.com/defs#/definitions/name' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema, { schemas })

  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, {})
})

/* ------------------------------------------------------------------ */
/* numeric bounds (acceptance case 4)                                  */
/* ------------------------------------------------------------------ */

test('bounds-tightened: minimum 0 -> 18 yields a value in between', () => {
  const oldSchema = { type: 'object', properties: { age: { type: 'integer', minimum: 0 } } }
  const newSchema = { type: 'object', properties: { age: { type: 'integer', minimum: 18 } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  const counterexample = result.counterexamples[0]
  assert.deepStrictEqual(counterexample.input, { age: 17 })
  assert.strictEqual(counterexample.reason, 'bound-tightened')
  assert.strictEqual(counterexample.verified.oldAccepts, true)
  assert.strictEqual(counterexample.verified.newRejects, true)
})

test('bounds-tightened: maximum shrunk yields a value above the new max', () => {
  const oldSchema = { type: 'object', properties: { v: { type: 'number', maximum: 10 } } }
  const newSchema = { type: 'object', properties: { v: { type: 'number', maximum: 5 } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  const value = result.counterexamples[0].input.v
  assert.strictEqual(result.counterexamples[0].reason, 'bound-tightened')
  assert.ok(value > 5 && value <= 10, 'expected value in (5, 10], got ' + value)
})

test('bounds-tightened: exclusiveMaximum added at the boundary', () => {
  const oldSchema = { type: 'object', properties: { v: { type: 'number', minimum: 0, maximum: 10 } } }
  const newSchema = { type: 'object', properties: { v: { type: 'number', minimum: 0, exclusiveMaximum: 10 } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { v: 10 })
})

test('bounds loosened is compatible', () => {
  const oldSchema = { type: 'object', properties: { v: { type: 'integer', minimum: 18 } } }
  const newSchema = { type: 'object', properties: { v: { type: 'integer', minimum: 0 } } }
  const result = checkSchemaCompatibility(oldSchema, newSchema)
  assert.strictEqual(result.verdict, 'compatible')
})

/* ------------------------------------------------------------------ */
/* unknown (acceptance case 5)                                         */
/* ------------------------------------------------------------------ */

test('unknown: allOf in the new schema never yields compatible', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { name: { allOf: [{ type: 'string' }] } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'unknown')
  assert.strictEqual(result.reason, 'unsupported-keyword')
  assert.ok(result.unsupported.some(u => u.keyword === 'allOf'))
})

test('unknown: anyOf, oneOf, not are also unsupported', () => {
  for (const keyword of ['anyOf', 'oneOf', 'not']) {
    const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
    const newSchema = { type: 'object', properties: { name: { [keyword]: [{ type: 'string' }] } } }
    const result = checkSchemaCompatibility(oldSchema, newSchema)
    assert.strictEqual(result.verdict, 'unknown', keyword + ' should be unknown')
  }
})

test('unknown: format and pattern are out of scope', () => {
  const oldSchema = { type: 'object', properties: { email: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { email: { type: 'string', format: 'email' } } }
  const result = checkSchemaCompatibility(oldSchema, newSchema)
  assert.strictEqual(result.verdict, 'unknown')
})

/* ------------------------------------------------------------------ */
/* validator read-only isolation (acceptance case 6)                    */
/* ------------------------------------------------------------------ */

test('validator read-only isolation: schemas and input are never mutated', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string', default: 'x' } } }
  const newSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
  const schemas = {}

  const oldSnapshot = clone(oldSchema)
  const newSnapshot = clone(newSchema)
  const schemasSnapshot = clone(schemas)
  const input = {}
  const inputSnapshot = clone(input)

  checkSchemaCompatibility(oldSchema, newSchema, { schemas })

  assert.deepStrictEqual(oldSchema, oldSnapshot, 'old schema was mutated')
  assert.deepStrictEqual(newSchema, newSnapshot, 'new schema was mutated')
  assert.deepStrictEqual(schemas, schemasSnapshot, 'registered schemas were mutated')
  assert.deepStrictEqual(input, inputSnapshot, 'input was mutated')
})

test('coercion and default filling happen on clones, not the original input', () => {
  const createAjvCompiler = require('@fastify/ajv-compiler')
  const oldSchema = { type: 'object', properties: { name: { type: 'string', default: 'x' } } }
  const newSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const schemas = {}

  const build = createAjvCompiler()
  const validate = build(schemas, { customOptions: {} })({ schema: oldSchema })

  const original = {}
  const isolated = clone(original)
  validate(isolated)

  assert.deepStrictEqual(original, {}, 'original input was mutated by default filling')
  assert.deepStrictEqual(isolated, { name: 'x' }, 'clone should have been filled with the default')

  // The new validator is independent and must not see the filled default.
  const buildNew = createAjvCompiler()
  const validateNew = buildNew(schemas, { customOptions: {} })({ schema: newSchema })
  const fresh = clone(original)
  assert.strictEqual(validateNew(fresh), true)
  assert.deepStrictEqual(fresh, {})
})

test('two independent validators are used for old and new', () => {
  const oldSchema = { type: 'object', properties: { name: { type: 'string' } } }
  const newSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.strictEqual(result.counterexamples[0].verified.oldAccepts, true)
  assert.strictEqual(result.counterexamples[0].verified.newRejects, true)
})

/* ------------------------------------------------------------------ */
/* type changes and arrays                                             */
/* ------------------------------------------------------------------ */

test('type change string -> number yields a string value', () => {
  const oldSchema = { type: 'object', properties: { v: { type: 'string' } } }
  const newSchema = { type: 'object', properties: { v: { type: 'number' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { v: 'string' })
})

test('array items: required-added inside an element yields a one-element array', () => {
  const oldSchema = {
    type: 'object',
    properties: {
      list: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } }
    }
  }
  const newSchema = {
    type: 'object',
    properties: {
      list: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }
    }
  }

  const result = checkSchemaCompatibility(oldSchema, newSchema)

  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { list: [{}] })
})

/* ------------------------------------------------------------------ */
/* querystring part                                                    */
/* ------------------------------------------------------------------ */

test('querystring part is reported and checked', () => {
  const oldSchema = { type: 'object', properties: { q: { type: 'string' } } }
  const newSchema = { type: 'object', required: ['q'], properties: { q: { type: 'string' } } }

  const result = checkSchemaCompatibility(oldSchema, newSchema, { part: 'querystring' })

  assert.strictEqual(result.verdict, 'incompatible')
  assert.strictEqual(result.part, 'querystring')
  assert.deepStrictEqual(result.counterexamples[0].input, {})
})

/* ------------------------------------------------------------------ */
/* identical schemas are compatible                                    */
/* ------------------------------------------------------------------ */

test('identical schemas are compatible', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', enum: ['a', 'b'] },
      age: { type: 'integer', minimum: 0, maximum: 120 }
    }
  }
  const result = checkSchemaCompatibility(schema, schema)
  assert.strictEqual(result.verdict, 'compatible')
})

/* ------------------------------------------------------------------ */
/* CLI (local Node command)                                            */
/* ------------------------------------------------------------------ */

function runCli (args) {
  const cli = path.join(__dirname, '..', 'scripts', 'schema-compat.js')
  try {
    const stdout = execFileSync(process.execPath, [cli].concat(args), { encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (err) {
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
  }
}

test('CLI: required-added exits 1 and prints the counterexample', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-required.json'),
    '--new', path.join(fixturesDir, 'new-required.json')
  ])
  assert.strictEqual(status, 1)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, {})
})

test('CLI: enum-narrowed exits 1 and gives b', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-enum.json'),
    '--new', path.join(fixturesDir, 'new-enum.json')
  ])
  assert.strictEqual(status, 1)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.counterexamples[0].input.color, 'b')
})

test('CLI: bounds-tightened exits 1', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-bounds.json'),
    '--new', path.join(fixturesDir, 'new-bounds.json')
  ])
  assert.strictEqual(status, 1)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.counterexamples[0].input.age, 17)
})

test('CLI: $ref resolves with --schemas and exits 1', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-ref.json'),
    '--new', path.join(fixturesDir, 'new-ref.json'),
    '--schemas', path.join(fixturesDir, 'schemas.json')
  ])
  assert.strictEqual(status, 1)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.verdict, 'incompatible')
  assert.deepStrictEqual(result.counterexamples[0].input, { user: {} })
})

test('CLI: unknown exits 2 and never reports compatible', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-same.json'),
    '--new', path.join(fixturesDir, 'new-unknown.json')
  ])
  assert.strictEqual(status, 2)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.verdict, 'unknown')
})

test('CLI: compatible exits 0', () => {
  const { status, stdout } = runCli([
    '--old', path.join(fixturesDir, 'old-same.json'),
    '--new', path.join(fixturesDir, 'old-same.json')
  ])
  assert.strictEqual(status, 0)
  const result = JSON.parse(stdout)
  assert.strictEqual(result.verdict, 'compatible')
})

test('CLI: --help exits 0 and prints usage', () => {
  const { status, stdout } = runCli(['--help'])
  assert.strictEqual(status, 0)
  assert.ok(stdout.includes('Usage'))
})

test('CLI: missing arguments exits 3', () => {
  const { status } = runCli([])
  assert.strictEqual(status, 3)
})
