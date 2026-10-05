'use strict'

/**
 * Sealed plugin configuration example.
 *
 * When `sealPluginConfig` is enabled, every plugin receives a read-only
 * frozen snapshot of its options. Parent scopes pass an independent
 * snapshot to child scopes: a child may override a key without mutating
 * the parent's snapshot. Functions are kept by reference (never invoked)
 * and circular references keep their shared identity.
 *
 * The source scope of every key is recorded along the scope chain. It can
 * be queried with `getConfigSource` and `getConfigSourceChain`, but the
 * chain only exposes scope names, never values.
 *
 * Run with:
 *   node examples/sealed-config.js
 */

const Fastify = require('../fastify')
const {
  getConfigSource,
  getConfigSourceChain
} = require('../fastify')

const fastify = Fastify({
  logger: false,
  sealPluginConfig: true
})

// The caller's original options object. It will be mutated after
// registration to prove that the sealed snapshot is unaffected.
const parentOptions = {
  nested: { x: 1 },
  onlyParent: 'parent value',
  greet: function greet () { return 'hello' }
}

// Keep a reference to the parent snapshot for the final assertion.
const kParentOpts = Symbol('parentOpts')

fastify.register(function parent (instance, opts, done) {
  fastify[kParentOpts] = opts

  console.log('[parent] nested.x =', opts.nested.x)
  console.log('[parent] onlyParent =', opts.onlyParent)
  console.log('[parent] greet identity preserved =', opts.greet === parentOptions.greet)
  console.log('[parent] frozen =', Object.isFrozen(opts))

  // Register a child scope that overrides `nested.x`.
  instance.register(function child (instance, opts, done) {
    console.log('[child] nested.x =', opts.nested.x)
    console.log('[child] onlyParent (inherited) =', opts.onlyParent)
    console.log('[child] frozen =', Object.isFrozen(opts))

    // Query the source scope of each key.
    console.log('[child] source of nested =', getConfigSource(opts, 'nested'))
    console.log('[child] source of onlyParent =', getConfigSource(opts, 'onlyParent'))
    console.log('[child] source chain =', getConfigSourceChain(opts))

    done()
  }, { nested: { x: 2 } })

  done()
}, parentOptions)

fastify.ready().then(() => {
  // Mutate the original caller object after registration.
  parentOptions.nested.x = 999
  parentOptions.onlyParent = 'mutated'

  console.log('--- after mutating the original options object ---')
  console.log('original parentOptions.nested.x =', parentOptions.nested.x, '(mutated)')
  console.log('sealed snapshots are unaffected:')
  console.log('  parent snapshot nested.x =', fastify[kParentOpts].nested.x)
  console.log('  parent snapshot onlyParent =', fastify[kParentOpts].onlyParent)
  console.log('  parent snapshot still frozen =', Object.isFrozen(fastify[kParentOpts]))

  fastify.close()
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
