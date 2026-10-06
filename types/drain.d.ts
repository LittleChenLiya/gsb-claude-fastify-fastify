/**
 * Drain state codes returned by the group maintenance API.
 *
 * - `active`: the group accepts traffic.
 * - `draining`: the group rejects new requests, in-flight requests complete.
 * - `drained`: the drain completed (all in-flight requests of the current
 *   generation finished); the group still rejects new requests until
 *   `resumeDrain()` is called.
 */
export type DrainStateCode = 'active' | 'draining' | 'drained'

/**
 * Point-in-time view of a drain group. Callers must use `state` and
 * `generation` (never `activeCount` alone) to know whether a drain
 * completed before a resume.
 */
export interface DrainStateSnapshot {
  /** Name of the route group. */
  group: string;
  /** Current state code of the group. */
  state: DrainStateCode;
  /** Generation (epoch) number; increments on every `resumeDrain()`. */
  generation: number;
  /** In-flight requests of the current generation. */
  activeCount: number;
}

/** Configurable maintenance response returned while a group is draining. */
export interface DrainResponseOptions {
  /** HTTP status code, defaults to 503. */
  statusCode?: number;
  /** Response body: string, Buffer, or a JSON-serializable value. */
  payload?: unknown;
  /** Extra response headers (merged over the JSON defaults). */
  headers?: Record<string, string | number | string[]>;
}

/** Options for `fastify.waitDrain()`. */
export interface WaitDrainOptions {
  /**
   * Cancels only the caller's wait with an AbortError; it never resumes
   * the group and never affects other waiters.
   */
  signal?: AbortSignal;
}
