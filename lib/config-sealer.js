'use strict'

const { kTestInternals } = require('./symbols.js')

// Internal symbol used to carry the sealed configuration snapshot through the
// avvio register options. It is keyed by a symbol so it never collides with,
// nor changes, the public `register(plugin, opts)` contract.
const kSealedConfigInput = Symbol('fastify.sealedConfigInput')

function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSnapshotable (value) {
  return Array.isArray(value) || isPlainObject(value)
}

// Deeply clones plain objects and arrays. Shared references and circular
// structures are preserved through the `seen` map: every source object maps
// to exactly one clone, so `a === b` in the input stays `a === b` in the
// snapshot and cycles point back to the same cloned object.
// Functions keep their identity and are never invoked. Non plain objects
// (Date, RegExp, Map, class instances, ...) also keep their identity.
function snapshotValue (value, seen) {
  if (typeof value === 'function') return value
  if (value === null || typeof value !== 'object') return value
  if (!isSnapshotable(value)) return value

  const cached = seen.get(value)
  if (cached !== undefined) return cached

  const clone = Array.isArray(value) ? [] : {}
  seen.set(value, clone)
  for (const key of Object.keys(value)) {
    clone[key] = snapshotValue(value[key], seen)
  }
  return clone
}

// Recursively freezes the cloned containers. Functions and non plain objects
// are left untouched (never frozen, never called). Cycles are guarded by the
// `seen` set.
function deepFreeze (value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (!isSnapshotable(value)) return value
  if (seen.has(value)) return value
  seen.add(value)

  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen)
  }
  Object.freeze(value)
  return value
}

// Produces an immutable, independent snapshot of the given configuration.
// Mutating the original object after this call cannot affect the result.
function sealConfig (config) {
  if (config === undefined || config === null) return config
  return deepFreeze(snapshotValue(config, new Map()))
}

function mergeValues (baseValue, overrideValue, seen) {
  if (overrideValue === undefined) {
    return snapshotValue(baseValue, seen)
  }
  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    return mergeSnapshots(baseValue, overrideValue, seen)
  }
  return snapshotValue(overrideValue, seen)
}

// Deeply merges an already sealed parent configuration with an already sealed
// child configuration into a brand new graph. Child keys win; plain objects
// merge recursively; arrays and scalars are replaced. Neither input is
// mutated, so overriding a value in the child never changes the parent.
function mergeSnapshots (base, override, seen = new Map()) {
  let clone = seen.get(base)
  if (clone === undefined) {
    clone = {}
    seen.set(base, clone)
  }

  const overrideKeys = new Set(Object.keys(override))
  for (const key of Object.keys(base)) {
    if (!overrideKeys.has(key)) {
      clone[key] = snapshotValue(base[key], seen)
    }
  }
  for (const key of overrideKeys) {
    clone[key] = mergeValues(base[key], override[key], seen)
  }
  return clone
}

// Computes the sealed configuration of a new encapsulation context.
// - no own config: the child inherits an independent snapshot of the parent
//   configuration, so later changes to the child cannot leak into the parent
// - own config: it is merged on top of the inherited snapshot
// `ownSealedConfig` must already be sealed via `sealConfig`.
function buildSealedConfig (parentConfig, ownSealedConfig) {
  if (ownSealedConfig === undefined) {
    if (parentConfig === undefined || parentConfig === null) {
      return parentConfig
    }
    return deepFreeze(snapshotValue(parentConfig, new Map()))
  }
  if (parentConfig === undefined || parentConfig === null) {
    return ownSealedConfig
  }
  return deepFreeze(mergeSnapshots(parentConfig, ownSealedConfig))
}

module.exports = {
  kSealedConfigInput,
  sealConfig,
  buildSealedConfig
}

module.exports[kTestInternals] = {
  snapshotValue,
  deepFreeze,
  mergeSnapshots
}
