'use strict'

/**
 * 90-second local demo of the route-group maintenance (drain) API.
 *
 * Two route groups (A and B) receive continuous traffic. Group A is drained
 * twice while group B keeps serving. Every second the demo prints the state
 * code, generation and in-flight count of each group, plus how many
 * responses were 200s and how many were maintenance 503s.
 *
 * Run with: node examples/drain-maintenance.js
 * Custom duration (ms): DRAIN_DEMO_DURATION_MS=30000 node examples/drain-maintenance.js
 */

const Fastify = require('../fastify.js')

const DURATION_MS = Number(process.env.DRAIN_DEMO_DURATION_MS || 90_000)
const TICK_MS = 1_000

const fastify = Fastify()

// Simulated workload: each request takes 0.5-2s to complete.
function work () {
  return new Promise((resolve) => {
    setTimeout(resolve, 500 + Math.floor(Math.random() * 1500))
  })
}

fastify.register(async function groupA (instance) {
  instance.get('/a/work', async () => {
    await work()
    return { group: 'A', ok: true }
  })
}, { drainGroup: 'A' })

fastify.register(async function groupB (instance) {
  instance.get('/b/work', async () => {
    await work()
    return { group: 'B', ok: true }
  })
}, { drainGroup: 'B' })

const stats = {
  A: { ok: 0, rejected: 0 },
  B: { ok: 0, rejected: 0 }
}

let stopped = false

function fire (group, url) {
  fastify.inject(url).then((res) => {
    if (res.statusCode === 200) stats[group].ok++
    else stats[group].rejected++
  }).catch(() => {})
}

function trafficLoop () {
  if (stopped) return
  fire('A', '/a/work')
  fire('B', '/b/work')
  setTimeout(trafficLoop, 300).unref()
}

function fmt (snapshot) {
  const state = snapshot.state.padEnd(8)
  return `state=${state} gen=${snapshot.generation} active=${snapshot.activeCount}`
}

function printStatus (elapsedSec) {
  const a = fastify.drainState('A')
  const b = fastify.drainState('B')
  console.log(
    `[t=${String(elapsedSec).padStart(3, '0')}s] ` +
    `A: ${fmt(a)} ok=${stats.A.ok} 503=${stats.A.rejected} | ` +
    `B: ${fmt(b)} ok=${stats.B.ok} 503=${stats.B.rejected}`
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main () {
  await fastify.ready()
  console.log(`drain demo: running for ${DURATION_MS / 1000}s, printing state codes and active counts every second`)
  console.log('--- phase 1: normal traffic on groups A and B ---')

  trafficLoop()
  const startedAt = Date.now()
  const ticker = setInterval(() => printStatus(Math.floor((Date.now() - startedAt) / 1000)), TICK_MS)

  const at = async (sec, fn) => {
    const delay = startedAt + sec * 1000 - Date.now()
    if (delay > 0) {
      // unref'd: phases scheduled beyond the demo duration never hold the
      // process open once the demo is over
      await new Promise((resolve) => setTimeout(resolve, delay).unref())
    }
    if (!stopped) await fn()
  }

  // phase 2 (t=10s): drain group A. In-flight requests finish, new ones
  // get the configured 503, group B is untouched.
  at(10, () => {
    console.log('--- phase 2: beginDrain(A) with a custom maintenance response ---')
    const snapshot = fastify.beginDrain('A', {
      statusCode: 503,
      payload: { maintenance: true, group: 'A' },
      headers: { 'retry-after': '30' }
    })
    console.log('beginDrain(A) ->', snapshot)
    fastify.waitDrain('A').then((done) => {
      console.log('waitDrain(A) resolved ->', done)
    })
  })

  // phase 3 (t=25s): resume group A, a new generation starts.
  at(25, () => {
    console.log('--- phase 3: resumeDrain(A), new generation ---')
    console.log('resumeDrain(A) ->', fastify.resumeDrain('A'))
  })

  // phase 4 (t=40s): drain A again, with two waiters; one cancels its own
  // wait shortly after. Cancelling a wait never resumes the routes.
  at(40, () => {
    console.log('--- phase 4: beginDrain(A) again, two waiters, one will cancel ---')
    console.log('beginDrain(A) ->', fastify.beginDrain('A'))

    fastify.waitDrain('A').then((done) => {
      console.log('waiter 1 (patient) resolved ->', done)
    })

    const controller = new AbortController()
    fastify.waitDrain('A', { signal: controller.signal }).then(
      (done) => console.log('waiter 2 resolved (unexpected) ->', done),
      (err) => console.log(`waiter 2 cancelled as requested (${err.name}); group A keeps draining`)
    )
    // abort while the drain is still pending (in-flight work takes >= 500ms)
    setTimeout(() => controller.abort(), 600)
  })

  // phase 5 (t=55s): resume A again and run normally until the end.
  at(55, () => {
    console.log('--- phase 5: resumeDrain(A), back to normal until the end ---')
    console.log('resumeDrain(A) ->', fastify.resumeDrain('A'))
  })

  await sleep(DURATION_MS)
  stopped = true
  clearInterval(ticker)
  printStatus(Math.floor((Date.now() - startedAt) / 1000))
  console.log('final:', { A: fastify.drainState('A'), B: fastify.drainState('B') })
  await fastify.close()
  console.log('demo finished')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
