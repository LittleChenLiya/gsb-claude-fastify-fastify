'use strict'

// Explicit read-only config sealing for plugin registration.
//
// Run the targeted tests for this feature with:
//   node --test test/sealed-config.test.js
//
// Run this example with:
//   node examples/sealed-config.js

const Fastify = require('../fastify')

const fastify = Fastify()

// The object passed by the caller. It is snapshotted and deeply frozen at
// registration time: mutating it afterwards cannot affect the sealed config.
const parentConfig = {
  nested: { x: 1 },
  greeting: 'hello'
}

fastify.registerSealed(async function parentPlugin (instance) {
  // { nested: { x: 1 }, greeting: 'hello' } (frozen snapshot)
  instance.log.info({ config: instance.getSealedConfig() }, 'parent sealed config')
  // [ 'parentPlugin' ] - source chain: names only, never values
  instance.log.info({ sources: instance.getSealedConfigSources() }, 'parent config sources')

  // The child inherits an independent snapshot of the parent config and
  // overrides `nested.x` without changing the parent snapshot.
  instance.registerSealed(async function childPlugin (child) {
    // { nested: { x: 2 }, greeting: 'hello' }
    child.log.info({ config: child.getSealedConfig() }, 'child sealed config')
    // [ 'parentPlugin', 'childPlugin' ]
    child.log.info({ sources: child.getSealedConfigSources() }, 'child config sources')

    child.get('/', async () => ({
      childX: child.getSealedConfig().nested.x,
      parentX: instance.getSealedConfig().nested.x
    }))
  }, { nested: { x: 2 } })
}, parentConfig)

// This mutation happens after registration and does NOT leak into the
// sealed snapshots: parent still sees nested.x === 1.
parentConfig.nested.x = 999

fastify.ready().then(() => {
  return fastify.inject('/')
}).then((res) => {
  console.log(res.payload) // => {"childX":2,"parentX":1}
  return fastify.close()
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
