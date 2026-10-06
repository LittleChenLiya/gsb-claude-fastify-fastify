'use strict'

const { test } = require('node:test')
const http = require('node:http')
const { Readable } = require('node:stream')
const Fastify = require('..')
const { sleep } = require('./helper')

function barrier () {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

async function listen (fastify) {
  await fastify.listen({ port: 0 })
  const { port } = fastify.server.address()
  return `http://127.0.0.1:${port}`
}

test('drain a single group: in-flight finishes, new requests get 503, other groups stay available', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gate = barrier()
  fastify.get('/a', { drainGroup: 'A' }, async () => {
    await gate.promise
    return { group: 'a' }
  })
  fastify.get('/b', { drainGroup: 'B' }, async () => ({ group: 'b' }))

  const base = await listen(fastify)

  // hold a request of group A behind the barrier
  const inFlight = fetch(`${base}/a`)
  await sleep(50)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 0, state: 'available', active: 1 })

  const handle = fastify.beginDrain('A')
  t.assert.strictEqual(handle.generation, 0)
  t.assert.strictEqual(fastify.drainState('A').state, 'draining')
  t.assert.strictEqual(fastify.drainState('A').active, 1)

  // new request to group A is rejected with the default 503
  const rejected = await fetch(`${base}/a`)
  t.assert.strictEqual(rejected.status, 503)
  t.assert.deepStrictEqual(await rejected.json(), {
    error: 'Service Unavailable',
    message: 'Service Unavailable',
    statusCode: 503
  })

  // group B is untouched
  const other = await fetch(`${base}/b`)
  t.assert.strictEqual(other.status, 200)
  t.assert.deepStrictEqual(await other.json(), { group: 'b' })

  // rejected requests are not accounted as in-flight
  t.assert.strictEqual(fastify.drainState('A').active, 1)

  // release the barrier: the in-flight request completes normally
  gate.release()
  const inFlightRes = await inFlight
  t.assert.strictEqual(inFlightRes.status, 200)
  t.assert.deepStrictEqual(await inFlightRes.json(), { group: 'a' })

  const done = await handle.wait()
  t.assert.deepStrictEqual(done, { group: 'A', generation: 0, state: 'drained', active: 0 })
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')
})

test('resume opens a new generation and counters are rechecked after resume', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gates = []
  fastify.get('/a', { drainGroup: 'A' }, async () => {
    const gate = barrier()
    gates.push(gate)
    await gate.promise
    return { ok: true }
  })

  const base = await listen(fastify)

  const first = fetch(`${base}/a`)
  await sleep(50)
  fastify.beginDrain('A')
  t.assert.strictEqual(fastify.drainState('A').state, 'draining')

  // resume while the old request is still in flight: a new generation opens
  const resumed = fastify.resume('A')
  t.assert.deepStrictEqual(resumed, { group: 'A', generation: 1, state: 'available', active: 0 })

  // the group accepts traffic again right away
  const second = fetch(`${base}/a`)
  await sleep(50)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 1, state: 'available', active: 1 })

  // completing the old-generation request must not touch the new counters
  gates[0].release()
  await first
  await sleep(50)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 1, state: 'available', active: 1 })

  gates[1].release()
  await second
  await sleep(50)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 1, state: 'available', active: 0 })
})

test('two consecutive generations: old completions never decrement the new generation', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gates = []
  fastify.get('/a', { drainGroup: 'A' }, async () => {
    const gate = barrier()
    gates.push(gate)
    await gate.promise
    return { ok: true }
  })

  const base = await listen(fastify)

  // generation 0: one in-flight request, then drain
  const r1 = fetch(`${base}/a`)
  await sleep(50)
  fastify.beginDrain('A')

  // switch to generation 1 and admit a new request there
  fastify.resume('A')
  const r2 = fetch(`${base}/a`)
  await sleep(50)

  // drain generation 1 as well
  const handle = fastify.beginDrain('A')
  t.assert.strictEqual(handle.generation, 1)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 1, state: 'draining', active: 1 })

  // finish the generation-0 request: generation 1 counters stay untouched
  gates[0].release()
  await r1
  await sleep(50)
  t.assert.deepStrictEqual(fastify.drainState('A'), { group: 'A', generation: 1, state: 'draining', active: 1 })

  // finish the generation-1 request: only now the drain completes
  gates[1].release()
  await r2
  const done = await handle.wait()
  t.assert.deepStrictEqual(done, { group: 'A', generation: 1, state: 'drained', active: 0 })
})

test('repeated beginDrain shares the same generation state', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/a', { drainGroup: 'A' }, async () => ({ ok: true }))
  await listen(fastify)

  const first = fastify.beginDrain('A')
  const second = fastify.beginDrain('A')
  t.assert.strictEqual(first.generation, second.generation)
  t.assert.strictEqual(fastify.drainState('A').state, 'drained') // no in-flight requests

  // both handles wait on the same shared state and resolve immediately
  t.assert.strictEqual((await first.wait()).state, 'drained')
  t.assert.strictEqual((await second.wait()).state, 'drained')

  const resumed = fastify.resume('A')
  t.assert.strictEqual(resumed.generation, 1)
  t.assert.strictEqual(resumed.state, 'available')
})

test('two waiters, one cancels: abort only cancels the caller wait, routes stay draining', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gate = barrier()
  fastify.get('/a', { drainGroup: 'A' }, async () => {
    await gate.promise
    return { ok: true }
  })

  const base = await listen(fastify)

  const inFlight = fetch(`${base}/a`)
  await sleep(50)
  fastify.beginDrain('A')

  const controller = new AbortController()
  const waiter1 = fastify.waitForDrain('A', { signal: controller.signal })
  const waiter2 = fastify.waitForDrain('A')

  controller.abort()
  await t.assert.rejects(waiter1, (err) => {
    t.assert.strictEqual(err.name, 'AbortError')
    return true
  })

  // cancelling the wait did not resume the group
  t.assert.strictEqual(fastify.drainState('A').state, 'draining')
  const rejected = await fetch(`${base}/a`)
  t.assert.strictEqual(rejected.status, 503)

  // the second waiter still resolves when the drain completes
  gate.release()
  await inFlight
  const done = await waiter2
  t.assert.deepStrictEqual(done, { group: 'A', generation: 0, state: 'drained', active: 0 })
})

test('waitForDrain on an available group resolves immediately', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/a', { drainGroup: 'A' }, async () => ({ ok: true }))
  await listen(fastify)

  const snapshot = await fastify.waitForDrain('A')
  t.assert.deepStrictEqual(snapshot, { group: 'A', generation: 0, state: 'available', active: 0 })
})

test('streamed responses count as complete only when the response truly ends (client aborts early)', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/stream', { drainGroup: 'S' }, (request, reply) => {
    let i = 0
    const stream = new Readable({
      read () {
        if (i++ < 1000) {
          setTimeout(() => this.push(`chunk-${i}\n`), 10)
        } else {
          this.push(null)
        }
      }
    })
    reply.send(stream)
  })

  const base = await listen(fastify)
  const { port } = new URL(base)

  // start a streamed response and begin the drain while it flows
  let abortRequest
  const firstChunk = new Promise((resolve) => {
    const req = http.request({ port, path: '/stream' }, (res) => {
      res.once('data', () => resolve())
      res.resume()
    })
    req.on('error', () => {})
    req.end()
    abortRequest = () => req.destroy()
  })

  // wait until the stream is actually flowing to the client
  await firstChunk
  t.assert.strictEqual(fastify.drainState('S').active, 1)
  fastify.beginDrain('S')
  t.assert.strictEqual(fastify.drainState('S').state, 'draining')

  // abort the download mid-stream: the response never finishes cleanly,
  // the connection 'close' is what completes the in-flight accounting
  abortRequest()
  const done = await fastify.waitForDrain('S')
  t.assert.deepStrictEqual(done, { group: 'S', generation: 0, state: 'drained', active: 0 })
})

test('error handler responses are tracked until the error response finishes', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gate = barrier()
  fastify.setErrorHandler((error, request, reply) => {
    reply.status(500).send({ custom: 'error', message: error.message })
  })
  fastify.get('/boom', { drainGroup: 'E' }, async () => {
    await gate.promise
    throw new Error('kaboom')
  })

  const base = await listen(fastify)

  const inFlight = fetch(`${base}/boom`)
  await sleep(50)
  fastify.beginDrain('E')
  t.assert.deepStrictEqual(fastify.drainState('E'), { group: 'E', generation: 0, state: 'draining', active: 1 })

  gate.release()
  const res = await inFlight
  t.assert.strictEqual(res.status, 500)
  t.assert.deepStrictEqual(await res.json(), { custom: 'error', message: 'kaboom' })

  const done = await fastify.waitForDrain('E')
  t.assert.deepStrictEqual(done, { group: 'E', generation: 0, state: 'drained', active: 0 })
})

test('encapsulation inheritance: register option sets the group, route option overrides it', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function grouped (child) {
    child.get('/inherited', async () => ({ where: 'inherited' }))
    child.get('/override', { drainGroup: 'H' }, async () => ({ where: 'override' }))
    child.register(async function nested (grandchild) {
      grandchild.get('/deep', async () => ({ where: 'deep' }))
    })
  }, { prefix: '/g', drainGroup: 'G' })

  fastify.get('/root', async () => ({ where: 'root' }))

  const base = await listen(fastify)

  fastify.beginDrain('G')

  const inherited = await fetch(`${base}/g/inherited`)
  t.assert.strictEqual(inherited.status, 503)

  const deep = await fetch(`${base}/g/deep`)
  t.assert.strictEqual(deep.status, 503)

  const override = await fetch(`${base}/g/override`)
  t.assert.strictEqual(override.status, 200)
  t.assert.deepStrictEqual(await override.json(), { where: 'override' })

  const root = await fetch(`${base}/root`)
  t.assert.strictEqual(root.status, 200)

  // draining the overriding group does not affect the inherited one
  fastify.resume('G')
  fastify.beginDrain('H')
  t.assert.strictEqual((await fetch(`${base}/g/override`)).status, 503)
  t.assert.strictEqual((await fetch(`${base}/g/inherited`)).status, 200)
})

test('configurable maintenance response', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/a', { drainGroup: 'A' }, async () => ({ ok: true }))
  fastify.get('/b', { drainGroup: 'B' }, async () => ({ ok: true }))

  const base = await listen(fastify)

  fastify.beginDrain('A', {
    statusCode: 503,
    payload: { maintenance: true, retryAfter: 30 },
    headers: { 'x-maintenance': 'yes' }
  })
  const resA = await fetch(`${base}/a`)
  t.assert.strictEqual(resA.status, 503)
  t.assert.strictEqual(resA.headers.get('x-maintenance'), 'yes')
  t.assert.deepStrictEqual(await resA.json(), { maintenance: true, retryAfter: 30 })

  fastify.beginDrain('B', {
    payload: 'down for maintenance'
  })
  const resB = await fetch(`${base}/b`)
  t.assert.strictEqual(resB.status, 503)
  t.assert.match(resB.headers.get('content-type'), /text\/plain/)
  t.assert.strictEqual(await resB.text(), 'down for maintenance')
})

test('invalid drain group names are rejected', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  t.assert.throws(() => fastify.get('/bad', { drainGroup: 42 }, async () => ({})), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.beginDrain(''), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.beginDrain(null), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.drainState({}), /FST_ERR_DRAIN_GROUP_INVALID/)
})

test('drain completion vs resume ordering is told apart by state codes', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const gate = barrier()
  fastify.get('/a', { drainGroup: 'A' }, async () => {
    await gate.promise
    return { ok: true }
  })

  const base = await listen(fastify)

  const inFlight = fetch(`${base}/a`)
  await sleep(50)
  const handle = fastify.beginDrain('A')

  // resume before the drain completed: the new generation is available while
  // the old one is still draining — the active count of the new generation
  // being zero must not be mistaken for the old drain being finished
  fastify.resume('A')
  t.assert.strictEqual(fastify.drainState('A').state, 'available')
  t.assert.strictEqual(fastify.drainState('A').active, 0)

  let oldDrained = false
  handle.wait().then(() => { oldDrained = true })
  await sleep(50)
  t.assert.strictEqual(oldDrained, false)

  gate.release()
  await inFlight
  const done = await handle.wait()
  t.assert.strictEqual(done.state, 'drained')
  t.assert.strictEqual(done.generation, 0)
})
