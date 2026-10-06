'use strict'

const { test } = require('node:test')
const http = require('node:http')
const { Readable } = require('node:stream')
const Fastify = require('..')

// A barrier blocks a handler until release() is called.
function barrier () {
  let release
  let entered
  const gate = new Promise((resolve) => { release = resolve })
  const arrived = new Promise((resolve) => { entered = resolve })
  return { gate, arrived, release, entered }
}

function buildBarrierApp (t, barrierA) {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a/work', async () => {
      barrierA.entered()
      await barrierA.gate
      return { group: 'A', ok: true }
    })
  }, { drainGroup: 'A' })

  fastify.register(async function groupB (instance) {
    instance.get('/b/work', async () => ({ group: 'B', ok: true }))
  }, { drainGroup: 'B' })

  return fastify
}

test('barrier: draining group A rejects new requests with 503 while group B stays available, in-flight requests complete', async (t) => {
  const barrierA = barrier()
  const fastify = buildBarrierApp(t, barrierA)
  await fastify.ready()

  // 1. start a request in group A and hold it with the barrier
  const inflight = fastify.inject('/a/work')
  await barrierA.arrived

  // 2. begin the drain: the in-flight request keeps running
  const begun = fastify.beginDrain('A')
  t.assert.strictEqual(begun.state, 'draining')
  t.assert.strictEqual(begun.activeCount, 1)

  // 3. new requests to group A get an immediate 503, group B is unaffected
  const rejected = await fastify.inject('/a/work')
  t.assert.strictEqual(rejected.statusCode, 503)
  t.assert.deepStrictEqual(JSON.parse(rejected.payload), {
    error: 'Service Unavailable',
    message: 'Service Unavailable',
    statusCode: 503
  })

  const other = await fastify.inject('/b/work')
  t.assert.strictEqual(other.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(other.payload), { group: 'B', ok: true })

  // 4. the drain is still pending while the barrier holds the request
  const drainingSnapshot = fastify.drainState('A')
  t.assert.strictEqual(drainingSnapshot.state, 'draining')
  t.assert.strictEqual(drainingSnapshot.activeCount, 1)

  const waited = fastify.waitDrain('A')

  // 5. release the barrier: the old request completes and the drain finishes
  barrierA.release()
  const inflightResponse = await inflight
  t.assert.strictEqual(inflightResponse.statusCode, 200)

  const completed = await waited
  t.assert.strictEqual(completed.state, 'drained')
  t.assert.strictEqual(completed.activeCount, 0)
  t.assert.strictEqual(completed.generation, begun.generation)
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')

  // 6. resume and check the counters of the new generation
  const resumed = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual(resumed.activeCount, 0)
  t.assert.strictEqual(resumed.generation, begun.generation + 1)

  // new traffic is accepted again (the barrier gate is already released)
  const after = await fastify.inject('/a/work')
  t.assert.strictEqual(after.statusCode, 200)
  // ...and the counters settled back on the new generation
  t.assert.strictEqual(fastify.drainState('A').state, 'active')
  t.assert.strictEqual(fastify.drainState('A').activeCount, 0)
  t.assert.strictEqual(fastify.drainState('B').state, 'active')
})

test('repeated beginDrain shares the same generation, resume starts a new one', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a', async () => 'a')
  }, { drainGroup: 'A' })
  await fastify.ready()

  const first = fastify.beginDrain('A')
  const second = fastify.beginDrain('A')
  t.assert.strictEqual(first.state, 'drained') // no in-flight requests
  t.assert.strictEqual(second.state, 'drained')
  t.assert.strictEqual(second.generation, first.generation)

  // a third call while drained still shares the same generation state
  const third = fastify.beginDrain('A')
  t.assert.strictEqual(third.generation, first.generation)

  const gen1 = first.generation
  const resumed = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual(resumed.generation, gen1 + 1)

  // two consecutive generation switches
  const drainAgain = fastify.beginDrain('A')
  t.assert.strictEqual(drainAgain.state, 'drained')
  t.assert.strictEqual(drainAgain.generation, gen1 + 1)

  const resumed2 = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed2.state, 'active')
  t.assert.strictEqual(resumed2.generation, gen1 + 2)

  // resume on an active group is a no-op and does not bump the generation
  const resumed3 = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed3.generation, gen1 + 2)
})

test('old generation completions never decrement the new generation counters', async (t) => {
  const barrier1 = barrier()
  const barrier2 = barrier()
  let current = barrier1

  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a', async () => {
      const b = current
      b.entered()
      await b.gate
      return 'a'
    })
  }, { drainGroup: 'A' })
  await fastify.ready()

  // generation 1: one in-flight request
  const req1 = fastify.inject('/a')
  await barrier1.arrived
  t.assert.strictEqual(fastify.drainState('A').activeCount, 1)

  // drain generation 1, then resume before the old request finished
  fastify.beginDrain('A')
  const gen1 = fastify.drainState('A').generation
  const resumed = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual(resumed.generation, gen1 + 1)

  // generation 2: a new in-flight request is counted on the new generation
  current = barrier2
  const req2 = fastify.inject('/a')
  await barrier2.arrived
  t.assert.strictEqual(fastify.drainState('A').activeCount, 1)

  // the old generation 1 request completes: the new generation must keep
  // its own count untouched, and the state code must stay 'active'
  barrier1.release()
  await req1
  const afterOld = fastify.drainState('A')
  t.assert.strictEqual(afterOld.state, 'active')
  t.assert.strictEqual(afterOld.generation, gen1 + 1)
  t.assert.strictEqual(afterOld.activeCount, 1)

  barrier2.release()
  await req2
  const afterAll = fastify.drainState('A')
  t.assert.strictEqual(afterAll.state, 'active')
  t.assert.strictEqual(afterAll.activeCount, 0)
})

test('two waiters on the same drain: aborting one only cancels that caller', async (t) => {
  const barrierA = barrier()
  const fastify = buildBarrierApp(t, barrierA)
  await fastify.ready()

  const inflight = fastify.inject('/a/work')
  await barrierA.arrived
  fastify.beginDrain('A')

  const waiter1 = fastify.waitDrain('A')
  const controller = new AbortController()
  const waiter2 = fastify.waitDrain('A', { signal: controller.signal })

  // cancelling waiter2 rejects only that promise with an AbortError
  controller.abort()
  await t.assert.rejects(waiter2, (err) => {
    t.assert.strictEqual(err.name, 'AbortError')
    return true
  })

  // the group is still draining: cancelling a wait must not resume routes
  t.assert.strictEqual(fastify.drainState('A').state, 'draining')
  const rejected = await fastify.inject('/a/work')
  t.assert.strictEqual(rejected.statusCode, 503)

  // waiter1 still completes when the in-flight request finishes
  barrierA.release()
  await inflight
  const completed = await waiter1
  t.assert.strictEqual(completed.state, 'drained')
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')
})

test('waitDrain with an already aborted signal rejects immediately', async (t) => {
  const barrierA = barrier()
  const fastify = buildBarrierApp(t, barrierA)
  await fastify.ready()

  const inflight = fastify.inject('/a/work')
  await barrierA.arrived
  fastify.beginDrain('A')

  const controller = new AbortController()
  controller.abort()
  await t.assert.rejects(fastify.waitDrain('A', { signal: controller.signal }), (err) => {
    t.assert.strictEqual(err.name, 'AbortError')
    return true
  })

  barrierA.release()
  await inflight
  await fastify.waitDrain('A')
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')
})

test('waitDrain on a non-draining group resolves immediately with the state code', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.get('/', async () => 'ok')
  await fastify.ready()

  const unknown = await fastify.waitDrain('never-seen')
  t.assert.deepStrictEqual(unknown, { group: 'never-seen', state: 'active', generation: 0, activeCount: 0 })

  fastify.beginDrain('g')
  const drained = await fastify.waitDrain('g')
  t.assert.strictEqual(drained.state, 'drained')
})

test('resume settles pending waiters with the outgoing state code, not a fake completion', async (t) => {
  const barrierA = barrier()
  const fastify = buildBarrierApp(t, barrierA)
  await fastify.ready()

  const inflight = fastify.inject('/a/work')
  await barrierA.arrived
  fastify.beginDrain('A')

  const waited = fastify.waitDrain('A')
  const gen1 = fastify.drainState('A').generation

  // resume before the drain completed: the waiter is settled with the
  // outgoing snapshot (state 'draining'), so callers can tell the drain
  // did NOT complete before the resume by looking at the state code
  const resumed = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual(resumed.generation, gen1 + 1)

  const settled = await waited
  t.assert.strictEqual(settled.state, 'draining')
  t.assert.strictEqual(settled.generation, gen1)

  // the old request still completes against its own generation
  barrierA.release()
  await inflight
  const now = fastify.drainState('A')
  t.assert.strictEqual(now.state, 'active')
  t.assert.strictEqual(now.generation, gen1 + 1)
  t.assert.strictEqual(now.activeCount, 0)
})

test('error handler path: a failing in-flight request releases its generation when the error response ends', async (t) => {
  const barrierA = barrier()
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.setErrorHandler((err, request, reply) => {
      reply.code(500).send({ custom: true, message: err.message })
    })
    instance.get('/a/boom', async () => {
      barrierA.entered()
      await barrierA.gate
      throw new Error('kaboom')
    })
  }, { drainGroup: 'A' })
  await fastify.ready()

  const inflight = fastify.inject('/a/boom')
  await barrierA.arrived

  fastify.beginDrain('A')
  t.assert.strictEqual(fastify.drainState('A').activeCount, 1)
  const waited = fastify.waitDrain('A')

  barrierA.release()
  const response = await inflight
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.deepStrictEqual(JSON.parse(response.payload), { custom: true, message: 'kaboom' })

  const completed = await waited
  t.assert.strictEqual(completed.state, 'drained')
  t.assert.strictEqual(completed.activeCount, 0)
})

test('streaming response: the request stays counted until the stream is fully flushed', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let pushChunk
  fastify.register(async function groupA (instance) {
    instance.get('/a/stream', (request, reply) => {
      const stream = new Readable({
        read () {
          pushChunk = () => {
            this.push(null)
          }
        }
      })
      reply.send(stream)
    })
  }, { drainGroup: 'A' })
  await fastify.ready()

  const inflight = fastify.inject('/a/stream')
  // give the server a tick to enter the route
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  fastify.beginDrain('A')
  const draining = fastify.drainState('A')
  t.assert.strictEqual(draining.state, 'draining')
  t.assert.strictEqual(draining.activeCount, 1)

  const waited = fastify.waitDrain('A')
  pushChunk()
  const response = await inflight
  t.assert.strictEqual(response.statusCode, 200)

  const completed = await waited
  t.assert.strictEqual(completed.state, 'drained')
  t.assert.strictEqual(completed.activeCount, 0)
})

test('client abort: an interrupted streaming response releases its generation', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let enteredStream
  const streamEntered = new Promise((resolve) => { enteredStream = resolve })
  fastify.register(async function groupA (instance) {
    instance.get('/a/stream', (request, reply) => {
      const stream = new Readable({
        read () {
          enteredStream()
          // never ends on its own: the client will go away
        }
      })
      stream.push('chunk-1\n')
      reply.send(stream)
    })
  }, { drainGroup: 'A' })

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const { port } = fastify.server.address()

  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/a/stream' }, (res) => {
      res.once('data', () => {
        // abort the client side while the stream is still open
        req.destroy()
        resolve()
      })
      res.resume()
    })
    req.on('error', () => {})
    req.end()
  })
  await streamEntered

  // the request is still counted until the server notices the abort
  fastify.beginDrain('A')
  const completed = await fastify.waitDrain('A')
  t.assert.strictEqual(completed.state, 'drained')
  t.assert.strictEqual(completed.activeCount, 0)
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')
})

test('encapsulation inheritance: register option, nested scopes, route override and opt-out', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.get('/root', async () => 'root')

  fastify.register(async function groupA (instance) {
    instance.get('/a/one', async () => 'a-one')

    instance.register(async function nested (nestedInstance) {
      // inherits the group of the parent scope
      nestedInstance.get('/a/nested', async () => 'a-nested')
    })

    instance.register(async function overridden (nestedInstance) {
      // nested scope with its own group
      nestedInstance.get('/a2/deep', async () => 'a2-deep')
    }, { drainGroup: 'A2' })

    // route level override joins another group
    instance.get('/a/as-b', { drainGroup: 'B' }, async () => 'a-as-b')

    // route level opt-out leaves the inherited group
    instance.get('/a/free', { drainGroup: null }, async () => 'a-free')
  }, { drainGroup: 'A' })

  fastify.register(async function groupB (instance) {
    instance.get('/b/one', async () => 'b-one')
  }, { drainGroup: 'B' })

  await fastify.ready()

  fastify.beginDrain('A')

  t.assert.strictEqual((await fastify.inject('/a/one')).statusCode, 503)
  t.assert.strictEqual((await fastify.inject('/a/nested')).statusCode, 503)
  t.assert.strictEqual((await fastify.inject('/a2/deep')).statusCode, 200)
  t.assert.strictEqual((await fastify.inject('/a/as-b')).statusCode, 200)
  t.assert.strictEqual((await fastify.inject('/a/free')).statusCode, 200)
  t.assert.strictEqual((await fastify.inject('/b/one')).statusCode, 200)
  t.assert.strictEqual((await fastify.inject('/root')).statusCode, 200)

  fastify.beginDrain('A2')
  t.assert.strictEqual((await fastify.inject('/a2/deep')).statusCode, 503)

  fastify.beginDrain('B')
  t.assert.strictEqual((await fastify.inject('/a/as-b')).statusCode, 503)
  t.assert.strictEqual((await fastify.inject('/b/one')).statusCode, 503)
  t.assert.strictEqual((await fastify.inject('/a/free')).statusCode, 200)
})

test('configurable maintenance response: status code, payload and headers', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a', async () => 'a')
  }, { drainGroup: 'A' })
  await fastify.ready()

  fastify.beginDrain('A', {
    statusCode: 503,
    payload: { maintenance: true, group: 'A' },
    headers: { 'x-maintenance': 'yes', 'retry-after': '30' }
  })

  const res = await fastify.inject('/a')
  t.assert.strictEqual(res.statusCode, 503)
  t.assert.strictEqual(res.headers['x-maintenance'], 'yes')
  t.assert.strictEqual(res.headers['retry-after'], '30')
  t.assert.deepStrictEqual(JSON.parse(res.payload), { maintenance: true, group: 'A' })
})

test('configurable maintenance response: custom status code and string payload', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a', async () => 'a')
  }, { drainGroup: 'A' })
  await fastify.ready()

  fastify.beginDrain('A', { statusCode: 429, payload: 'come back later' })
  const res = await fastify.inject('/a')
  t.assert.strictEqual(res.statusCode, 429)
  t.assert.strictEqual(res.payload, 'come back later')
})

test('state codes, not zero counts, tell a completed drain apart from a resumed group', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  fastify.register(async function groupA (instance) {
    instance.get('/a', async () => 'a')
  }, { drainGroup: 'A' })
  await fastify.ready()

  // no traffic at all: activeCount is 0 in every state, only the state
  // code and the generation number carry the real information
  const drained = fastify.beginDrain('A')
  t.assert.strictEqual(drained.state, 'drained')
  t.assert.strictEqual(drained.activeCount, 0)

  const resumed = fastify.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual(resumed.activeCount, 0)
  t.assert.strictEqual(resumed.generation, drained.generation + 1)

  // a drained group keeps rejecting, an active one accepts: same count,
  // different state code
  fastify.beginDrain('A')
  t.assert.strictEqual((await fastify.inject('/a')).statusCode, 503)
  fastify.resumeDrain('A')
  t.assert.strictEqual((await fastify.inject('/a')).statusCode, 200)
})

test('validation: group names and drain response options', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  await fastify.ready()

  t.assert.throws(() => fastify.beginDrain(42), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.beginDrain(''), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.resumeDrain({}), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.drainState(null), /FST_ERR_DRAIN_GROUP_INVALID/)
  t.assert.throws(() => fastify.beginDrain('g', { statusCode: 99 }), /FST_ERR_DRAIN_RESPONSE_INVALID/)
  t.assert.throws(() => fastify.beginDrain('g', { statusCode: 1000 }), /FST_ERR_DRAIN_RESPONSE_INVALID/)
  t.assert.throws(() => fastify.beginDrain('g', { headers: 5 }), /FST_ERR_DRAIN_RESPONSE_INVALID/)
})

test('validation: invalid route and register drainGroup options', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  t.assert.throws(() => fastify.get('/bad', { drainGroup: 42, handler: async () => 'x' }), /FST_ERR_DRAIN_GROUP_INVALID/)

  fastify.register(async function bad () {}, { drainGroup: 42 })
  await t.assert.rejects(fastify.ready(), /FST_ERR_DRAIN_GROUP_INVALID/)
})

test('drainState of an unknown group reports a pristine active state', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  await fastify.ready()

  t.assert.deepStrictEqual(fastify.drainState('nope'), {
    group: 'nope',
    state: 'active',
    generation: 0,
    activeCount: 0
  })
})

test('drain API is available on encapsulated instances and shares one manager', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let child
  fastify.register(async function groupA (instance) {
    child = instance
    instance.get('/a', async () => 'a')
  }, { drainGroup: 'A' })
  await fastify.ready()

  const begun = child.beginDrain('A')
  t.assert.strictEqual(begun.state, 'drained')
  t.assert.strictEqual(fastify.drainState('A').state, 'drained')
  t.assert.strictEqual((await fastify.inject('/a')).statusCode, 503)

  const resumed = child.resumeDrain('A')
  t.assert.strictEqual(resumed.state, 'active')
  t.assert.strictEqual((await fastify.inject('/a')).statusCode, 200)
})
