<h1 align="center">Fastify</h1>

## Route Group Maintenance (Drain)

Fastify can switch a single route group to maintenance mode while the rest
of the server keeps serving traffic. When a group starts draining:

- requests already in flight run to completion (normal responses, streaming
  responses and error responses alike; a request only counts as finished
  when its response has truly ended or the client went away);
- new requests of that group immediately receive a configurable
  maintenance response (`503` by default);
- every other group stays fully available.

### Assigning routes to a group

Groups follow the encapsulation rules. A scope inherits the drain group of
its parent unless it declares its own:

```js
fastify.register(async function apiV1 (instance) {
  instance.get('/users', handler) // group "api-v1"

  instance.register(async function nested (nestedInstance) {
    nestedInstance.get('/orders', handler) // still group "api-v1"
  })

  instance.register(async function other (nestedInstance) {
    nestedInstance.get('/reports', handler) // group "reports"
  }, { drainGroup: 'reports' })

  // route level override and opt-out
  instance.get('/health', { drainGroup: null }, handler) // no group
  instance.get('/metrics', { drainGroup: 'ops' }, handler) // group "ops"
}, { drainGroup: 'api-v1' })
```

Routes without a group are never affected by a drain.

### API

- `fastify.beginDrain(group, [response])` �� starts the drain and returns a
  state snapshot. Repeated calls while draining share the same generation
  state. The optional `response` configures the maintenance response:
  `{ statusCode = 503, payload, headers }`.
- `fastify.waitDrain(group, [{ signal }])` �� resolves with the snapshot
  once the current generation is fully drained (`state: 'drained'`).
  Passing an `AbortSignal` cancels only that caller's wait (the promise
  rejects with an `AbortError`); it never resumes the routes and never
  affects other waiters.
- `fastify.resumeDrain(group)` �� explicitly resumes the group and starts a
  new generation. Requests still in flight from the old generation release
  their own counters and never decrement the new generation.
- `fastify.drainState(group)` �� returns the current snapshot.

A snapshot is `{ group, state, generation, activeCount }` where `state` is
one of the state codes `'active'`, `'draining'` or `'drained'`, and
`generation` increments on every resume. Always use the state code and the
generation number to know whether a drain completed before a resume ��
never `activeCount` alone, which is legitimately `0` in more than one
state.

```js
fastify.beginDrain('api-v1', {
  statusCode: 503,
  payload: { maintenance: true },
  headers: { 'retry-after': '30' }
})
const snapshot = await fastify.waitDrain('api-v1')
if (snapshot.state === 'drained') {
  // safe to take the group offline
}
fastify.resumeDrain('api-v1')
```

See [the demo](../../examples/drain-maintenance.js) for a 90-second runnable
walkthrough that prints state codes and active counts.
