'use strict'

const { STATUS_CODES } = require('node:http')
const { FST_ERR_DRAIN_GROUP_INVALID, FST_ERR_DRAIN_RESPONSE_INVALID } = require('./errors')

/**
 * Drain state codes. They are part of the public API: callers must rely on
 * these codes (and the generation number) to know whether a drain completed
 * before a resume, never on `activeCount` happening to be zero.
 */
const DRAIN_STATE_ACTIVE = 'active'
const DRAIN_STATE_DRAINING = 'draining'
const DRAIN_STATE_DRAINED = 'drained'

const drainStates = Object.freeze({
  active: DRAIN_STATE_ACTIVE,
  draining: DRAIN_STATE_DRAINING,
  drained: DRAIN_STATE_DRAINED
})

function validateDrainGroup (group) {
  if (typeof group !== 'string' || group.length === 0) {
    throw new FST_ERR_DRAIN_GROUP_INVALID(typeof group)
  }
}

function abortReason (signal) {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function buildDrainResponse (options) {
  if (options === undefined || options === null) {
    return defaultDrainResponse
  }

  const statusCode = options.statusCode ?? 503
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new FST_ERR_DRAIN_RESPONSE_INVALID('statusCode', typeof options.statusCode)
  }
  if (options.headers !== undefined && (typeof options.headers !== 'object' || options.headers === null || Array.isArray(options.headers))) {
    throw new FST_ERR_DRAIN_RESPONSE_INVALID('headers', typeof options.headers)
  }

  let payload = options.payload
  if (payload === undefined) {
    const message = STATUS_CODES[statusCode] ?? 'Error'
    payload = JSON.stringify({ error: message, message, statusCode })
  } else if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
    payload = JSON.stringify(payload)
  }

  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8'
  }, options.headers)
  headers['content-length'] = String(Buffer.byteLength(payload))

  return { statusCode, payload, headers }
}

const defaultDrainResponse = buildDrainResponse({})

/**
 * A generation tracks the in-flight requests of one epoch of a group.
 * Requests acquire a reference to the generation that was current when they
 * started and release that exact object when their response truly ends, so
 * requests from an old generation can never decrement the counters of a new
 * generation created by `resume()`.
 */
class DrainGeneration {
  constructor (id) {
    this.id = id
    this.activeCount = 0
    this.waiters = new Set()
  }
}

class DrainGroupState {
  constructor (name) {
    this.name = name
    this.state = DRAIN_STATE_ACTIVE
    this.generation = new DrainGeneration(1)
    this.response = defaultDrainResponse
  }
}

function snapshotOf (state) {
  return {
    group: state.name,
    state: state.state,
    generation: state.generation.id,
    activeCount: state.generation.activeCount
  }
}

function emptySnapshot (group) {
  return { group, state: DRAIN_STATE_ACTIVE, generation: 0, activeCount: 0 }
}

function maybeComplete (state) {
  if (state.state === DRAIN_STATE_DRAINING && state.generation.activeCount === 0) {
    state.state = DRAIN_STATE_DRAINED
    const snapshot = snapshotOf(state)
    for (const waiter of state.generation.waiters) {
      waiter.settle(snapshot)
    }
    state.generation.waiters.clear()
  }
}

class DrainManager {
  constructor () {
    this.groups = new Map()
  }

  getOrCreate (group) {
    validateDrainGroup(group)
    let state = this.groups.get(group)
    if (state === undefined) {
      state = new DrainGroupState(group)
      this.groups.set(group, state)
    }
    return state
  }

  snapshot (group) {
    validateDrainGroup(group)
    const state = this.groups.get(group)
    return state === undefined ? emptySnapshot(group) : snapshotOf(state)
  }

  /**
   * Switch a group to maintenance mode. Repeated calls while the group is
   * draining (or drained) share the very same generation state: they are
   * idempotent and never start a new epoch.
   */
  beginDrain (group, responseOptions) {
    const state = this.getOrCreate(group)
    if (state.state === DRAIN_STATE_ACTIVE) {
      // validate and build the response before mutating any state, so a
      // invalid configuration does not leave the group half-drained
      const response = buildDrainResponse(responseOptions)
      state.state = DRAIN_STATE_DRAINING
      state.response = response
      maybeComplete(state)
    }
    return snapshotOf(state)
  }

  /**
   * Called when a request enters a route of the group. Returns an idempotent
   * release function, or `null` when the group is not accepting new work.
   */
  enter (group) {
    const state = this.getOrCreate(group)
    if (state.state !== DRAIN_STATE_ACTIVE) {
      return null
    }
    const generation = state.generation
    generation.activeCount++
    let released = false
    return function release () {
      if (released) return
      released = true
      generation.activeCount--
      // Only the current generation of a draining group can complete the
      // drain. Releases of superseded generations only fix their own count.
      if (state.generation === generation) {
        maybeComplete(state)
      }
    }
  }

  /**
   * Precomputed rejection response for new requests of a draining group.
   */
  rejection (group) {
    const state = this.groups.get(group)
    return state === undefined ? defaultDrainResponse : state.response
  }

  /**
   * Wait for the current drain of the group to complete. The optional
   * AbortSignal only cancels the caller's own wait: it never resumes the
   * group and never touches other waiters.
   */
  waitDrain (group, options) {
    validateDrainGroup(group)
    const signal = options?.signal
    const state = this.groups.get(group)

    if (state === undefined) {
      return Promise.resolve(emptySnapshot(group))
    }
    if (state.state !== DRAIN_STATE_DRAINING) {
      return Promise.resolve(snapshotOf(state))
    }
    if (signal != null && signal.aborted) {
      return Promise.reject(abortReason(signal))
    }

    return new Promise((resolve, reject) => {
      const generation = state.generation
      const waiter = { settle: null }
      const onAbort = () => {
        generation.waiters.delete(waiter)
        reject(abortReason(signal))
      }
      waiter.settle = (snapshot) => {
        generation.waiters.delete(waiter)
        if (signal != null) {
          signal.removeEventListener('abort', onAbort)
        }
        resolve(snapshot)
      }
      generation.waiters.add(waiter)
      if (signal != null) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Explicitly resume a group: pending waiters of the outgoing generation are
   * settled with its last snapshot (state code `draining`/`drained`, never a
   * fake completion) and a brand new generation starts. Requests still flying
   * from the old generation release their own counters and cannot decrement
   * the new generation.
   */
  resume (group) {
    validateDrainGroup(group)
    const state = this.groups.get(group)
    if (state === undefined) {
      return emptySnapshot(group)
    }
    if (state.state === DRAIN_STATE_ACTIVE) {
      return snapshotOf(state)
    }
    const outgoing = snapshotOf(state)
    for (const waiter of state.generation.waiters) {
      waiter.settle(outgoing)
    }
    state.generation.waiters.clear()
    state.generation = new DrainGeneration(state.generation.id + 1)
    state.state = DRAIN_STATE_ACTIVE
    state.response = defaultDrainResponse
    return snapshotOf(state)
  }
}

module.exports = {
  DrainManager,
  drainStates,
  validateDrainGroup,
  DRAIN_STATE_ACTIVE,
  DRAIN_STATE_DRAINING,
  DRAIN_STATE_DRAINED
}
