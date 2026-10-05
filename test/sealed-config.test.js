'use strict'

// Targeted run command:
//   node --test test/sealed-config.test.js

const { test } = require('node:test')
const Fastify = require('..')

test('registerSealed seals parent config and child override does not change parent', async t => {
  t.plan(6)
  const fastify = Fastify()

  let parentConfig
  let childConfig

  fastify.registerSealed(async function parentPlugin (instance) {
    parentConfig = instance.getSealedConfig()
    instance.registerSealed(async function childPlugin (childInstance) {
      childConfig = childInstance.getSealedConfig()
    }, { nested: { x: 2 } })
  }, { nested: { x: 1 } })

  await fastify.ready()

  t.assert.strictEqual(parentConfig.nested.x, 1)
  t.assert.strictEqual(childConfig.nested.x, 2)
  t.assert.notStrictEqual(childConfig.nested, parentConfig.nested)
  t.assert.strictEqual(fastify.getSealedConfig(), null)
  t.assert.ok(Object.isFrozen(parentConfig.nested))
  t.assert.ok(Object.isFrozen(childConfig.nested))
})

test('mutating the caller object after registration does not affect sealed snapshots', async t => {
  t.plan(10)
  const fastify = Fastify()

  const shared = { v: 1 }
  shared.self = shared // circular reference
  const original = { a: shared, b: shared, list: [shared] }

  let parentConfig
  let childConfig

  fastify.registerSealed(async function parentPlugin (instance) {
    parentConfig = instance.getSealedConfig()
    instance.registerSealed(async function childPlugin (childInstance) {
      childConfig = childInstance.getSealedConfig()
    }, { extra: true })
  }, original)

  // Mutate the caller-owned objects after registration.
  shared.v = 99
  original.a = null
  original.list.length = 0
  original.newKey = 'nope'

  await fastify.ready()

  for (const config of [parentConfig, childConfig]) {
    t.assert.strictEqual(config.a.v, 1)
    // shared references keep their identity inside the snapshot
    t.assert.strictEqual(config.a, config.b)
    // circular references point back to the same cloned object
    t.assert.strictEqual(config.a.self, config.a)
    t.assert.strictEqual(config.list[0], config.a)
  }
  t.assert.strictEqual(parentConfig.extra, undefined)
  t.assert.strictEqual(childConfig.extra, true)
})

test('sibling scopes do not see each other overrides', async t => {
  t.plan(3)
  const fastify = Fastify()

  let firstConfig
  let secondConfig

  fastify.registerSealed(async function parentPlugin (instance) {
    instance.registerSealed(async function firstChild (child) {
      firstConfig = child.getSealedConfig()
    }, { nested: { x: 2 } })
    instance.registerSealed(async function secondChild (child) {
      secondConfig = child.getSealedConfig()
    }, { other: true })
  }, { nested: { x: 1 } })

  await fastify.ready()

  t.assert.strictEqual(firstConfig.nested.x, 2)
  t.assert.strictEqual(secondConfig.nested.x, 1)
  t.assert.strictEqual(secondConfig.other, true)
})

test('sealed config is deeply frozen and functions keep identity without being called', async t => {
  t.plan(8)
  const fastify = Fastify()

  let called = 0
  const handler = () => { called++ }
  const config = { handler, deep: { nested: { handler } }, arr: [{ handler }] }

  let sealed
  fastify.registerSealed(async function plugin (instance) {
    sealed = instance.getSealedConfig()
  }, config)

  await fastify.ready()

  t.assert.strictEqual(sealed.handler, handler)
  t.assert.strictEqual(sealed.deep.nested.handler, handler)
  t.assert.strictEqual(sealed.arr[0].handler, handler)
  t.assert.strictEqual(called, 0)
  t.assert.ok(Object.isFrozen(sealed))
  t.assert.ok(Object.isFrozen(sealed.deep))
  t.assert.ok(Object.isFrozen(sealed.deep.nested))
  t.assert.ok(Object.isFrozen(sealed.arr))
})

test('config sources are recorded by scope chain and expose no values', async t => {
  t.plan(6)
  const fastify = Fastify()

  let parentSources
  let childSources
  let grandChildSources

  fastify.registerSealed(async function parentPlugin (instance) {
    parentSources = instance.getSealedConfigSources()
    instance.registerSealed(async function childPlugin (child) {
      childSources = child.getSealedConfigSources()
      child.register(async function grandChild (grand) {
        grandChildSources = grand.getSealedConfigSources()
      })
    }, { secret: 'child-value' })
  }, { secret: 'parent-value' })

  await fastify.ready()

  t.assert.deepStrictEqual([...parentSources], ['parentPlugin'])
  t.assert.deepStrictEqual([...childSources], ['parentPlugin', 'childPlugin'])
  // plain register inherits the chain without adding an entry
  t.assert.deepStrictEqual([...grandChildSources], ['parentPlugin', 'childPlugin'])
  t.assert.deepStrictEqual([...fastify.getSealedConfigSources()], [])
  // the source chain is queryable but never outputs config values
  t.assert.ok(childSources.every(source => typeof source === 'string'))
  t.assert.ok(!JSON.stringify(childSources).includes('parent-value'))
})

test('plain register inherits an independent snapshot of the parent sealed config', async t => {
  t.plan(4)
  const fastify = Fastify()

  let parentConfig
  let childConfig

  fastify.registerSealed(async function parentPlugin (instance) {
    parentConfig = instance.getSealedConfig()
    instance.register(async function childPlugin (child) {
      childConfig = child.getSealedConfig()
    })
  }, { nested: { x: 1 } })

  await fastify.ready()

  t.assert.deepStrictEqual(childConfig, parentConfig)
  t.assert.notStrictEqual(childConfig, parentConfig)
  t.assert.notStrictEqual(childConfig.nested, parentConfig.nested)
  t.assert.ok(Object.isFrozen(childConfig.nested))
})

test('normal register API and options are untouched', async t => {
  t.plan(4)
  const fastify = Fastify()

  t.assert.strictEqual(typeof fastify.register, 'function')
  t.assert.strictEqual(typeof fastify.registerSealed, 'function')

  let seenOpts
  fastify.register(async function plugin (instance, opts) {
    seenOpts = opts
  }, { prefix: '/api' })

  await fastify.ready()

  t.assert.strictEqual(seenOpts.prefix, '/api')
  // no sealed config leaks into a scope that never used registerSealed
  t.assert.strictEqual(seenOpts && Object.keys(seenOpts).includes('sealedConfig'), false)
})
