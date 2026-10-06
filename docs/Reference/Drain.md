<h1 align="center">Fastify</h1>

## Route Group Drain (Maintenance Mode)

Fastify can switch a single route group to maintenance mode while the rest of
the application keeps serving traffic. When a group is draining:

+ requests already in flight keep running and are tracked until their response
  has **truly ended** (`finish` or `close` on the raw response — this covers
  normal responses, streamed responses, error-handler responses and clients
  disconnecting mid-stream),
+ new requests of the group immediately receive a configurable `503`
  maintenance response,
+ every other group stays fully available.

### Assigning routes to a group

Routes join a group through the `drainGroup` route option, or inherit it from
the `drainGroup` option of the `register` call of their encapsulation context.
A route-level `drainGroup` always overrides the inherited one; routes without
any group are never affected by draining.

```js
fastify.register(async (child) => {
  child.get('/inherited', handler)              // group 'billing'
  child.get('/override', { drainGroup: 'other' }, handler) // group 'other'
  child.register(async (grandchild) => {
    grandchild.get('/nested', handler)          // inherits group 'billing'
  })
}, { prefix: '/billing', drainGroup: 'billing' })
```

### API

+ `fastify.beginDrain(group, maintenance?)` — switches the group to
  maintenance mode and returns a handle `{ group, generation, state, active,
  wait(options?) }`. Repeated calls while the group is already draining share
  the same generation state. The optional `maintenance` object configures the
  rejection response: `{ statusCode = 503, payload, headers }`, where
  `payload` is an object (sent as JSON) or a string (sent as `text/plain`).
+ `handle.wait(options?)` / `fastify.waitForDrain(group, options?)` — resolves
  with a state snapshot once every in-flight request of the generation has
  completed. Pass `{ signal }` to cancel the wait: aborting only cancels the
  caller's own wait — it never resumes the group and does not affect other
  waiters.
+ `fastify.resume(group)` — explicitly leaves maintenance mode. The current
  generation is sealed and a fresh generation (id + 1) becomes current, so
  late completions of old requests never decrement the new generation's
  counters.
+ `fastify.drainState(group)` — returns a snapshot
  `{ group, generation, state, active }`.

### State codes and generations

Each group generation reports exactly one state code:

| code        | meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `available` | accepting new requests                                          |
| `draining`  | maintenance mode: rejecting new requests, in-flight ones finish |
| `drained`   | draining and every in-flight request of this generation ended   |

Drain completion and `resume()` ordering must be told apart by these state
codes, never by observing `active === 0`: after a `resume()`, the new
generation reports `active: 0` while the previous generation may still be
draining its own requests.

```js
const handle = fastify.beginDrain('billing')
// ... load balancer drains traffic away ...
const done = await handle.wait() // { group: 'billing', generation: 0, state: 'drained', active: 0 }
// ... deploy, then:
fastify.resume('billing')
```

See `examples/drain-maintenance.js` for a 90 second live demo printing state
codes and active counts.
