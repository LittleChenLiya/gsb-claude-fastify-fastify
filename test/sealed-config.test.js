'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const {
  createSealedConfig,
  isSealedConfig,
  getConfigSource,
  getConfigSourceChain
} = require('../lib/sealed-config')

test('sealed config - basic snapshot is frozen and independent', async (t) => {
  t.plan(6)

  const input = { nested: { x: 1 }, name: 'test' }
  const config = createSealedConfig(input, null, 'root')

  t.assert.strictEqual(config.nested.x, 1)
  t.assert.strictEqual(config.name, 'test')
  t.assert.strictEqual(isSealedConfig(config), true)
  t.assert.strictEqual(Object.isFrozen(config), true)
  t.assert.strictEqual(Object.isFrozen(config.nested), true)

  // Mutating the original input after sealing must not affect the snapshot.
  input.nested.x = 999
  input.name = 'changed'
  t.assert.strictEqual(config.nested.x, 1)
})

test('sealed config - functions keep identity and are not called', async (t) => {
  t.plan(3)

  const fn = function hello () { return 'called' }
  const input = { fn }
  const config = createSealedConfig(input, null, 'root')

  t.assert.strictEqual(config.fn, fn)
  t.assert.strictEqual(typeof config.fn, 'function')
  // The function must not have been invoked during sealing.
  t.assert.strictEqual(config.fn(), 'called')
})

test('sealed config - circular references keep shared identity', async (t) => {
  t.plan(4)

  const input = { name: 'circ' }
  input.self = input
  input.nested = { parent: input }

  const config = createSealedConfig(input, null, 'root')

  t.assert.strictEqual(config.self, config)
  t.assert.strictEqual(config.nested.parent, config)
  t.assert.strictEqual(Object.isFrozen(config), true)
  t.assert.strictEqual(Object.isFrozen(config.nested), true)
})

test('sealed config - child inherits parent keys and overrides do not mutate parent', async (t) => {
  t.plan(6)

  const parentInput = { nested: { x: 1 }, onlyParent: 'p' }
  const parent = createSealedConfig(parentInput, null, 'parent')

  const childInput = { nested: { x: 2 } }
  const child = createSealedConfig(childInput, parent, 'child')

  t.assert.strictEqual(parent.nested.x, 1)
  t.assert.strictEqual(child.nested.x, 2)
  t.assert.strictEqual(child.onlyParent, 'p')
  // The parent snapshot must be untouched by the child override.
  t.assert.strictEqual(parent.nested.x, 1)
  t.assert.strictEqual(Object.isFrozen(child), true)
  t.assert.strictEqual(Object.isFrozen(child.nested), true)
})

test('sealed config - source chain is queryable but does not output values', async (t) => {
  t.plan(5)

  const parent = createSealedConfig({ nested: { x: 1 }, onlyParent: 'p' }, null, 'parent')
  const child = createSealedConfig({ nested: { x: 2 } }, parent, 'child')

  t.assert.strictEqual(getConfigSource(child, 'nested'), 'child')
  t.assert.strictEqual(getConfigSource(child, 'onlyParent'), 'parent')
  t.assert.strictEqual(getConfigSource(child, 'unknown'), null)

  const chain = getConfigSourceChain(child)
  t.assert.deepStrictEqual(chain, ['parent', 'child'])
  // The chain must only contain scope names (strings), never values.
  t.assert.strictEqual(chain.every((s) => typeof s === 'string'), true)
})

test('sealed config - mutating sealed config throws in strict mode', async (t) => {
  t.plan(2)

  const config = createSealedConfig({ nested: { x: 1 } }, null, 'root')

  t.assert.throws(() => {
    'use strict'
    config.nested.x = 999
  }, TypeError)

  t.assert.throws(() => {
    'use strict'
    config.newKey = 'bad'
  }, TypeError)
})

test('sealed config - empty input produces a frozen empty object', async (t) => {
  t.plan(2)

  const config = createSealedConfig(null, null, 'root')
  t.assert.strictEqual(Object.keys(config).length, 0)
  t.assert.strictEqual(Object.isFrozen(config), true)
})

test('plugin registration - sealed config is passed to the plugin', async (t) => {
  t.plan(3)

  const fastify = Fastify({ sealPluginConfig: true })
  const input = { nested: { x: 1 }, name: 'test' }

  fastify.register(function plugin (instance, opts, done) {
    t.assert.strictEqual(opts.nested.x, 1)
    t.assert.strictEqual(opts.name, 'test')
    t.assert.strictEqual(Object.isFrozen(opts), true)
    done()
  }, input)

  await fastify.ready()
})

test('plugin registration - child override does not mutate parent snapshot', async (t) => {
  t.plan(5)

  const fastify = Fastify({ sealPluginConfig: true })
  const parentInput = { nested: { x: 1 } }
  const childInput = { nested: { x: 2 } }
  let parentOpts
  let childOpts

  fastify.register(function parent (instance, opts, done) {
    parentOpts = opts
    instance.register(function child (instance, opts, done) {
      childOpts = opts
      done()
    }, childInput)
    done()
  }, parentInput)

  await fastify.ready()

  t.assert.strictEqual(parentOpts.nested.x, 1)
  t.assert.strictEqual(childOpts.nested.x, 2)
  t.assert.strictEqual(parentOpts.nested.x, 1)
  t.assert.strictEqual(Object.isFrozen(parentOpts), true)
  t.assert.strictEqual(Object.isFrozen(childOpts), true)
})

test('plugin registration - modifying original input after registration does not affect snapshots', async (t) => {
  t.plan(4)

  const fastify = Fastify({ sealPluginConfig: true })
  const parentInput = { nested: { x: 1 } }
  const childInput = { nested: { x: 2 } }
  let parentOpts
  let childOpts

  fastify.register(function parent (instance, opts, done) {
    parentOpts = opts
    instance.register(function child (instance, opts, done) {
      childOpts = opts
      done()
    }, childInput)
    done()
  }, parentInput)

  await fastify.ready()

  // Mutate the original caller objects after registration.
  parentInput.nested.x = 999
  childInput.nested.x = 888

  t.assert.strictEqual(parentOpts.nested.x, 1)
  t.assert.strictEqual(childOpts.nested.x, 2)
  t.assert.strictEqual(parentOpts.nested.x, 1)
  t.assert.strictEqual(childOpts.nested.x, 2)
})

test('plugin registration - source chain is queryable through the instance', async (t) => {
  t.plan(4)

  const fastify = Fastify({ sealPluginConfig: true })
  let childOpts

  fastify.register(function parent (instance, opts, done) {
    instance.register(function child (instance, opts, done) {
      childOpts = opts
      done()
    }, { nested: { x: 2 } })
    done()
  }, { nested: { x: 1 }, onlyParent: 'p' })

  await fastify.ready()

  t.assert.strictEqual(getConfigSource(childOpts, 'nested'), 'child')
  t.assert.strictEqual(getConfigSource(childOpts, 'onlyParent'), 'parent')
  t.assert.deepStrictEqual(getConfigSourceChain(childOpts), ['parent', 'child'])
  t.assert.strictEqual(
    getConfigSourceChain(childOpts).every((s) => typeof s === 'string'),
    true
  )
})

test('plugin registration - circular references and function identity in plugin opts', async (t) => {
  t.plan(4)

  const fastify = Fastify({ sealPluginConfig: true })
  const shared = { count: 0 }
  shared.self = shared
  const fn = function doThing () { return 'done' }
  const input = { shared, fn }
  let receivedOpts

  fastify.register(function plugin (instance, opts, done) {
    receivedOpts = opts
    done()
  }, input)

  await fastify.ready()

  t.assert.strictEqual(receivedOpts.shared.self, receivedOpts.shared)
  t.assert.strictEqual(receivedOpts.fn, fn)
  t.assert.strictEqual(typeof receivedOpts.fn, 'function')
  t.assert.strictEqual(Object.isFrozen(receivedOpts), true)
})

test('plugin registration - normal register is unchanged when sealing is disabled', async (t) => {
  t.plan(2)

  const fastify = Fastify()

  fastify.register(function plugin (instance, opts, done) {
    t.assert.strictEqual(typeof opts, 'object')
    t.assert.strictEqual(Object.isFrozen(opts), false)
    done()
  }, { key: 'value' })

  await fastify.ready()
})

test('plugin registration - encapsulated child scope inherits parent keys', async (t) => {
  t.plan(3)

  const fastify = Fastify({ sealPluginConfig: true })
  let childOpts

  fastify.register(function parent (instance, opts, done) {
    instance.register(function child (instance, opts, done) {
      childOpts = opts
      done()
    }, { nested: { x: 2 } })
    done()
  }, { nested: { x: 1 }, onlyParent: 'p', flag: true })

  await fastify.ready()

  t.assert.strictEqual(childOpts.onlyParent, 'p')
  t.assert.strictEqual(childOpts.flag, true)
  t.assert.strictEqual(childOpts.nested.x, 2)
})

test('plugin registration - skip-override plugin receives sealed config', async (t) => {
  t.plan(2)

  const fastify = Fastify({ sealPluginConfig: true })
  const plugin = function (instance, opts, done) {
    t.assert.strictEqual(opts.key, 'value')
    t.assert.strictEqual(Object.isFrozen(opts), true)
    done()
  }
  plugin[Symbol.for('skip-override')] = true

  fastify.register(plugin, { key: 'value' })

  await fastify.ready()
})

test('plugin registration - three-level nesting inherits correctly', async (t) => {
  t.plan(6)

  const fastify = Fastify({ sealPluginConfig: true })
  let grandchildOpts

  fastify.register(function root (instance, opts, done) {
    instance.register(function middle (instance, opts, done) {
      instance.register(function grandchild (instance, opts, done) {
        grandchildOpts = opts
        done()
      }, { level: 3 })
      done()
    }, { level: 2, middleOnly: 'm' })
    done()
  }, { level: 1, rootOnly: 'r' })

  await fastify.ready()

  t.assert.strictEqual(grandchildOpts.level, 3)
  t.assert.strictEqual(grandchildOpts.rootOnly, 'r')
  t.assert.strictEqual(grandchildOpts.middleOnly, 'm')
  t.assert.strictEqual(getConfigSource(grandchildOpts, 'level'), 'grandchild')
  t.assert.strictEqual(getConfigSource(grandchildOpts, 'rootOnly'), 'root')
  t.assert.deepStrictEqual(
    getConfigSourceChain(grandchildOpts),
    ['root', 'middle', 'grandchild']
  )
})

test('public API - source chain functions are exported from fastify', async (t) => {
  t.plan(5)

  const Fastify = require('..')
  const { getConfigSource, getConfigSourceChain, isSealedConfig } = Fastify

  t.assert.strictEqual(typeof getConfigSource, 'function')
  t.assert.strictEqual(typeof getConfigSourceChain, 'function')
  t.assert.strictEqual(typeof isSealedConfig, 'function')

  const parent = createSealedConfig({ nested: { x: 1 } }, null, 'parent')
  const child = createSealedConfig({ nested: { x: 2 } }, parent, 'child')

  t.assert.strictEqual(isSealedConfig(child), true)
  t.assert.deepStrictEqual(getConfigSourceChain(child), ['parent', 'child'])
})
