'use strict'

const rfdc = require('rfdc')({ circles: true, proto: false })
const { kSealedConfig } = require('./symbols.js')

const kSealedConfigSources = Symbol('fastify.sealedConfig.sources')
const kSealedConfigScope = Symbol('fastify.sealedConfig.scope')
const kSealedConfigParent = Symbol('fastify.sealedConfig.parent')

/**
 * Recursively freeze an object graph while preserving circular references.
 *
 * Unlike a naive deep freeze, this tracks every object already visited so
 * that a cycle (e.g. `obj.self = obj`) does not cause infinite recursion.
 * Functions are frozen by reference (Object.freeze on a function does not
 * invoke it and keeps its identity).
 *
 * @param {object} object The root object to freeze.
 * @param {WeakSet<object>} [visited] Internal set of already frozen objects.
 * @returns {object} The frozen object.
 */
function deepFreeze (object, visited = new WeakSet()) {
  if (object === null || typeof object !== 'object') {
    return object
  }
  if (visited.has(object)) {
    return object
  }
  visited.add(object)

  for (const key of Object.getOwnPropertyNames(object)) {
    const value = object[key]
    if (value !== null && typeof value === 'object') {
      deepFreeze(value, visited)
    }
  }

  return Object.freeze(object)
}

/**
 * Create a read-only sealed snapshot of a plugin configuration object.
 *
 * The snapshot is independent of the original `input` object: mutating the
 * input after registration has no effect on the sealed config. Circular
 * references are preserved (shared identity) and functions are kept by
 * reference (they are never invoked).
 *
 * When a `parent` sealed config is provided, the child scope inherits every
 * key that it does not define itself. The child's own keys take precedence
 * and never mutate the parent.
 *
 * For each key the scope that introduced or last overrode it is recorded.
 * The source information is queryable through {@link getConfigSource} and
 * {@link getConfigSourceChain} but it never exposes the actual configuration
 * values.
 *
 * @param {object} input The raw plugin options to seal.
 * @param {object | null} parent The parent scope's sealed config, if any.
 * @param {string} scopeName A human readable identifier for this scope.
 * @returns {object} A frozen plain object carrying the sealed config.
 */
function createSealedConfig (input, parent = null, scopeName = 'root') {
  if (input !== null && typeof input !== 'object') {
    throw new TypeError('sealed config input must be an object')
  }

  // Deep snapshot of the input. rfdc preserves circular references (shared
  // identity) and returns functions by reference (they are never invoked).
  const snapshot = rfdc(input || {})

  // Inherit the parent's keys. Keys already present in the snapshot (the
  // child's own overrides) take precedence and are never copied over.
  const sources = {}
  if (parent !== null && typeof parent === 'object' && kSealedConfig in parent) {
    const parentSources = parent[kSealedConfigSources]
    for (const key of Object.keys(parent)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
        snapshot[key] = parent[key]
      }
    }
    Object.assign(sources, parentSources)
  }

  // Record the source scope for every key introduced or overridden by this
  // scope. Inherited keys keep their original source.
  for (const key of Object.keys(snapshot)) {
    if (input !== null && Object.prototype.hasOwnProperty.call(input, key)) {
      sources[key] = scopeName
    }
  }

  // Attach metadata as non-enumerable, non-writable symbol-keyed properties
  // before freezing so they are locked down as well.
  Object.defineProperty(snapshot, kSealedConfig, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  })
  Object.defineProperty(snapshot, kSealedConfigSources, {
    value: deepFreeze(sources),
    enumerable: false,
    configurable: false,
    writable: false
  })
  Object.defineProperty(snapshot, kSealedConfigScope, {
    value: scopeName,
    enumerable: false,
    configurable: false,
    writable: false
  })
  Object.defineProperty(snapshot, kSealedConfigParent, {
    value: parent,
    enumerable: false,
    configurable: false,
    writable: false
  })

  // Recursively freeze the snapshot. Functions are preserved by reference;
  // Object.freeze on a function does not invoke it and keeps its identity.
  return deepFreeze(snapshot)
}

/**
 * Check whether an object is a sealed config produced by
 * {@link createSealedConfig}.
 *
 * @param {unknown} obj
 * @returns {boolean}
 */
function isSealedConfig (obj) {
  return obj !== null && typeof obj === 'object' && obj[kSealedConfig] === true
}

/**
 * Query the source scope of a configuration key. Returns the scope name (a
 * string) rather than the value, so the source chain never leaks
 * configuration values.
 *
 * @param {object} config A sealed config.
 * @param {string} key The configuration key to look up.
 * @returns {string | null} The scope name, or `null` if the key is unknown.
 */
function getConfigSource (config, key) {
  if (!isSealedConfig(config)) return null
  return config[kSealedConfigSources][key] || null
}

/**
 * Return the scope chain that produced a sealed config, from the outermost
 * (root) scope to the current scope. The chain contains scope names only and
 * never exposes configuration values.
 *
 * @param {object} config A sealed config.
 * @returns {string[]}
 */
function getConfigSourceChain (config) {
  if (!isSealedConfig(config)) return []
  const chain = []
  let current = config
  while (current !== null && isSealedConfig(current)) {
    chain.push(current[kSealedConfigScope])
    current = current[kSealedConfigParent]
  }
  return chain.reverse()
}

/**
 * Wrap a plugin function so that it receives the sealed config of its scope
 * instead of the raw options object. The wrapper preserves the plugin's
 * metadata (display name, plugin meta and skip-override flag) so that
 * avvio and the encapsulation logic behave exactly as before.
 *
 * @param {Function} plugin The original plugin function.
 * @returns {Function} The wrapped plugin function.
 */
function wrapPluginForSealing (plugin) {
  const wrapped = function (instance, opts, done) {
    // For encapsulated plugins the sealed snapshot lives on the instance.
    // For skip-override plugins (e.g. fastify-plugin) there is no new
    // instance, so the snapshot is attached to the wrapped function itself.
    const sealedConfig = instance[kSealedConfig] || wrapped[kSealedConfig]
    return plugin.call(this, instance, sealedConfig, done)
  }

  // Preserve the plugin metadata so avvio's naming and encapsulation checks
  // keep working with the wrapped function.
  const meta = plugin[Symbol.for('plugin-meta')]
  if (meta !== undefined) {
    Object.defineProperty(wrapped, Symbol.for('plugin-meta'), {
      value: meta,
      configurable: true,
      enumerable: false,
      writable: false
    })
  }
  const skipOverride = plugin[Symbol.for('skip-override')]
  if (skipOverride !== undefined) {
    Object.defineProperty(wrapped, Symbol.for('skip-override'), {
      value: skipOverride,
      configurable: true,
      enumerable: false,
      writable: false
    })
  }
  const displayName = plugin[Symbol.for('fastify.display-name')]
  if (displayName !== undefined) {
    Object.defineProperty(wrapped, Symbol.for('fastify.display-name'), {
      value: displayName,
      configurable: true,
      enumerable: false,
      writable: false
    })
  }
  Object.defineProperty(wrapped, 'name', {
    value: plugin.name,
    configurable: true,
    enumerable: false,
    writable: false
  })

  return wrapped
}

module.exports = createSealedConfig
module.exports.createSealedConfig = createSealedConfig
module.exports.isSealedConfig = isSealedConfig
module.exports.getConfigSource = getConfigSource
module.exports.getConfigSourceChain = getConfigSourceChain
module.exports.wrapPluginForSealing = wrapPluginForSealing
module.exports.kSealedConfig = kSealedConfig
