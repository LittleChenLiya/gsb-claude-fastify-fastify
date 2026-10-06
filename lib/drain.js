'use strict'

const { FST_ERR_DRAIN_GROUP_INVALID } = require('./errors')

// State codes (状态代号) exposed to users. A group generation is exactly one of:
// - 'available': accepting new requests
// - 'draining': maintenance mode, new requests are rejected, in-flight ones finish
// - 'drained': draining and every in-flight request of this generation has truly finished
const DRAIN_STATE_AVAILABLE = 'available'
const DRAIN_STATE_DRAINING = 'draining'
const DRAIN_STATE_DRAINED = 'drained'

const DEFAULT_MAINTENANCE = Object.freeze({
  statusCode: 503,
  payload: { error: 'Service Unavailable', message: 'Service Unavailable', statusCode: 503 },
  headers: Object.freeze({})
})

function assertValidGroup (group) {
  if (typeof group !== 'string' || group.length === 0) {
    throw new FST_ERR_DRAIN_GROUP_INVALID(typeof group)
  }
}

function normalizeMaintenance (maintenance) {
  if (maintenance === undefined || maintenance === null) {
    return DEFAULT_MAINTENANCE
  }
  if (typeof maintenance !== 'object') {
    throw new FST_ERR_DRAIN_GROUP_INVALID(typeof maintenance)
  }
  const statusCode = maintenance.statusCode ?? DEFAULT_MAINTENANCE.statusCode
  const payload = maintenance.payload ?? { ...DEFAULT_MAINTENANCE.payload, statusCode }
  const headers = maintenance.headers ?? DEFAULT_MAINTENANCE.headers
  return { statusCode, payload, headers }
}

/**
 * A generation is the unit of accounting for a route group.
 * Requests admitted while a generation is current are accounted on that
 * generation object only, so after `resume()` swaps in a fresh generation,
 * late completions of old requests can never corrupt the new counters.
 */
class DrainGeneration {
  constructor (id) {
    this.id = id
    this.active = 0
    this.draining = false
    this.drained = false
    this.waiters = new Set()
  }

  get code () {
    if (!this.draining) return DRAIN_STATE_AVAILABLE
    return this.drained ? DRAIN_STATE_DRAINED : DRAIN_STATE_DRAINING
  }
}

class DrainGroupState {
  constructor (name) {
    this.name = name
    this.generation = new DrainGeneration(0)
    this.maintenance = DEFAULT_MAINTENANCE
  }
}

class DrainManager {
  constructor () {
    this.groups = new Map()
  }

  getGroup (group) {
    assertValidGroup(group)
    let state = this.groups.get(group)
    if (state === undefined) {
      state = new DrainGroupState(group)
      this.groups.set(group, state)
    }
    return state
  }

  snapshot (state, generation = state.generation) {
    return {
      group: state.name,
      generation: generation.id,
      state: generation.code,
      active: generation.active
    }
  }

  /**
   * Switch a route group to maintenance mode. Repeated calls while the
   * current generation is already draining share the same generation state:
   * the generation id is kept and no new counters are created.
   */
  beginDrain (group, maintenance) {
    const state = this.getGroup(group)
    if (maintenance !== undefined) {
      state.maintenance = normalizeMaintenance(maintenance)
    }
    const generation = state.generation
    if (!generation.draining) {
      generation.draining = true
      if (generation.active === 0) {
        this.settleGeneration(generation)
      }
    }
    const manager = this
    return {
      ...this.snapshot(state, generation),
      wait (options) {
        return manager.waitForGeneration(state, generation, options)
      }
    }
  }

  /**
   * Admit a request of the given group. Returns the generation the request
   * is accounted on, or null when the group is draining and the request
   * must be rejected with the configured maintenance response.
   */
  admit (group) {
    const state = this.getGroup(group)
    const generation = state.generation
    if (generation.draining) {
      return null
    }
    generation.active++
    return generation
  }

  /**
   * A response truly ended ('finish' or 'close' on the raw response, whichever
   * first). Only then the in-flight request is considered complete.
   */
  complete (generation) {
    generation.active--
    if (generation.draining && generation.active === 0 && !generation.drained) {
      this.settleGeneration(generation)
    }
  }

  settleGeneration (generation) {
    generation.drained = true
    for (const waiter of generation.waiters) {
      waiter.settle()
    }
    generation.waiters.clear()
  }

  maintenance (group) {
    return this.getGroup(group).maintenance
  }

  /**
   * Wait until the current generation of the group is drained.
   * An AbortSignal only cancels the caller's own wait; it never resumes
   * the route group nor affects other waiters.
   */
  waitForDrain (group, options) {
    const state = this.getGroup(group)
    return this.waitForGeneration(state, state.generation, options)
  }

  waitForGeneration (state, generation, options) {
    const signal = options?.signal
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
        return
      }
      if (!generation.draining || generation.drained) {
        resolve(this.snapshot(state, generation))
        return
      }
      const waiter = {
        settle: () => {
          cleanup()
          resolve(this.snapshot(state, generation))
        }
      }
      const onAbort = () => {
        generation.waiters.delete(waiter)
        reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
      }
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      generation.waiters.add(waiter)
    })
  }

  /**
   * Explicitly leave maintenance mode: the current (possibly still draining)
   * generation is sealed and a fresh generation becomes current. Requests of
   * the old generation keep completing against the old counters.
   */
  resume (group) {
    const state = this.getGroup(group)
    const generation = state.generation
    if (generation.draining) {
      state.generation = new DrainGeneration(generation.id + 1)
    }
    return this.snapshot(state)
  }

  drainState (group) {
    return this.snapshot(this.getGroup(group))
  }
}

module.exports = {
  DrainManager,
  DRAIN_STATE_AVAILABLE,
  DRAIN_STATE_DRAINING,
  DRAIN_STATE_DRAINED
}
