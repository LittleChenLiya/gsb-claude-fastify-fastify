'use strict'

// Route-group maintenance (drain) demo.
//
// Two route groups, "A" and "B". Group A serves a slow endpoint whose
// requests are held behind a barrier, group B answers immediately.
// Over a 90 second timeline (1 tick = 1s, override with DRAIN_DEMO_TICK_MS
// for a quick run) the demo:
//   1. keeps background traffic flowing into both groups,
//   2. switches group A to maintenance with beginDrain('A') — in-flight
//      requests finish, new ones get the configured 503, group B is untouched,
//   3. shows two waiters where one cancels through an AbortSignal,
//   4. resumes group A into a new generation and drains it again,
//   5. prints the state code (available/draining/drained), generation and
//      active request count of every group once per tick.
//
// Run with: node examples/drain-maintenance.js

const Fastify = require('../fastify.js')

const TICK_MS = Number(process.env.DRAIN_DEMO_TICK_MS || 1000)
const TOTAL_TICKS = 90 // 90 seconds with the default tick

const fastify = Fastify({ logger: false })

// --- group A: slow, barrier-controlled endpoint -----------------------------
const gates = []
fastify.get('/a/slow', { drainGroup: 'A' }, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  gates.push(release)
  await gate
  return { group: 'A', done: true }
})
fastify.get('/a/fast', { drainGroup: 'A' }, async () => ({ group: 'A' }))

// --- group B: always fast ---------------------------------------------------
fastify.get('/b', { drainGroup: 'B' }, async () => ({ group: 'B' }))

function releaseAllGates () {
  while (gates.length > 0) gates.pop()()
}

function printState (tick, note = '') {
  const a = fastify.drainState('A')
  const b = fastify.drainState('B')
  const fmt = (s) => `gen=${s.generation} state=${s.state.padEnd(9)} active=${s.active}`
  console.log(`[t=${String(tick).padStart(2)}s] A(${fmt(a)}) | B(${fmt(b)})${note ? '  <- ' + note : ''}`)
}

async function main () {
  const address = await fastify.listen({ port: 0 })
  console.log(`demo server listening on ${address}`)
  console.log('timeline: t=10 beginDrain(A) | t=20 cancel waiter #1 | t=30 release + await drain')
  console.log('          t=40 resume(A) | t=50 beginDrain(A) again | t=60 release + resume(A)')
  console.log()

  // background traffic: one slow A request and a few fast requests per tick
  let stopTraffic = false
  const inFlight = new Set()
  const track = (p) => { inFlight.add(p); p.finally(() => inFlight.delete(p)) }
  const traffic = setInterval(() => {
    if (stopTraffic) return
    track(fetch(`${address}/a/slow`).then((r) => r.status).catch(() => 0))
    track(fetch(`${address}/a/fast`).then((r) => r.status).catch(() => 0))
    track(fetch(`${address}/b`).then((r) => r.status).catch(() => 0))
  }, TICK_MS)
  traffic.unref()

  const at = (tick, fn) => setTimeout(fn, tick * TICK_MS)

  let drainWaiters = []
  at(10, () => {
    const handle = fastify.beginDrain('A', {
      payload: { error: 'Service Unavailable', message: 'group A is under maintenance', statusCode: 503 },
      headers: { 'x-maintenance': 'group-a' }
    })
    console.log(`\n>>> beginDrain('A') called, generation ${handle.generation}`)
    const controller = new AbortController()
    drainWaiters = [
      fastify.waitForDrain('A', { signal: controller.signal })
        .then((s) => console.log('>>> waiter #1 resolved:', s))
        .catch((err) => console.log(`>>> waiter #1 cancelled (${err.name}) — group A keeps draining`)),
      handle.wait()
        .then((s) => console.log('>>> waiter #2 resolved (drain complete):', s))
    ]
    // waiter #1 cancels its own wait at t=20 (10 ticks from now); the
    // cancellation must not resume the group nor affect waiter #2
    setTimeout(() => controller.abort(), 10 * TICK_MS)
  })

  at(30, () => {
    console.log('>>> releasing in-flight requests of generation 0')
    releaseAllGates()
  })

  at(40, () => {
    const snap = fastify.resume('A')
    console.log(`>>> resume('A') -> new generation ${snap.generation}, state '${snap.state}'`)
  })

  at(50, () => {
    const handle = fastify.beginDrain('A')
    console.log(`>>> beginDrain('A') again, generation ${handle.generation}`)
    drainWaiters.push(handle.wait().then((s) => console.log('>>> generation 1 drained:', s)))
  })

  at(60, async () => {
    console.log('>>> releasing in-flight requests of generation 1')
    releaseAllGates()
    await Promise.allSettled(drainWaiters)
    const snap = fastify.resume('A')
    console.log(`>>> resume('A') -> generation ${snap.generation}, state '${snap.state}'\n`)
  })

  // status printer
  for (let tick = 0; tick <= TOTAL_TICKS; tick++) {
    at(tick, () => printState(tick))
  }

  at(TOTAL_TICKS, async () => {
    stopTraffic = true
    clearInterval(traffic)
    releaseAllGates()
    await Promise.allSettled([...inFlight])
    await fastify.close()
    console.log('\ndemo finished')
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
