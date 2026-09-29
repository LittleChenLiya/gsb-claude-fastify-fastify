'use strict'

const { test } = require('node:test')
const http = require('node:http')
const Fastify = require('..')

function deferred () {
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

test('trySend: only the first of two racing branches claims the reply', async t => {
  t.plan(4)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  const results = []
  const branches = []
  fastify.get('/', (request, reply) => {
    const first = deferred()
    const second = deferred()
    branches.push(first.promise.then(() => {
      results.push(reply.trySend({ branch: 'first' }))
    }))
    branches.push(second.promise.then(() => {
      results.push(reply.trySend({ branch: 'second' }))
    }))
    // The first branch arrives now, the second one arrives later,
    // after the winning branch already completed its pipeline.
    first.resolve()
    setImmediate(() => second.resolve())
    return reply
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  await Promise.all(branches)
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(response.body), { branch: 'first' })
})

test('trySend: serialization error produces a single error response', async t => {
  t.plan(5)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  const results = []
  const branches = []
  fastify.get('/', (request, reply) => {
    reply.serializer(() => {
      throw new Error('kaboom')
    })
    const first = deferred()
    const second = deferred()
    branches.push(first.promise.then(() => {
      results.push(reply.trySend({ branch: 'first' }))
    }))
    branches.push(second.promise.then(() => {
      results.push(reply.trySend({ branch: 'second' }))
    }))
    first.resolve()
    setImmediate(() => second.resolve())
    return reply
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  await Promise.all(branches)
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(response.statusCode, 500)
  const body = JSON.parse(response.body)
  t.assert.strictEqual(body.message, 'kaboom')
  t.assert.strictEqual(body.statusCode, 500)
})

test('trySend: custom error handler sends the single response', async t => {
  t.plan(4)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  fastify.setErrorHandler((error, request, reply) => {
    reply.code(418).send({ custom: error.message })
  })

  const results = []
  const branches = []
  fastify.get('/', (request, reply) => {
    const first = deferred()
    const second = deferred()
    branches.push(first.promise.then(() => {
      results.push(reply.trySend(new Error('kaboom')))
    }))
    branches.push(second.promise.then(() => {
      results.push(reply.trySend({ branch: 'second' }))
    }))
    first.resolve()
    setImmediate(() => second.resolve())
    return reply
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  await Promise.all(branches)
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(response.statusCode, 418)
  t.assert.deepStrictEqual(JSON.parse(response.body), { custom: 'kaboom' })
})

test('trySend: returns false when a plain send already claimed the reply', async t => {
  t.plan(4)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  const results = []
  fastify.get('/', (request, reply) => {
    reply.send({ branch: 'send' })
    results.push(reply.trySend({ branch: 'trySend' }))
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.deepStrictEqual(results, [false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(response.body), { branch: 'send' })
})

test('trySend: a later plain send does not produce a second response', async t => {
  t.plan(4)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  const results = []
  fastify.get('/', (request, reply) => {
    results.push(reply.trySend({ branch: 'trySend' }))
    reply.send({ branch: 'send' })
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.deepStrictEqual(results, [true])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(response.body), { branch: 'trySend' })
})

test('trySend: hijacked reply cannot be claimed', async t => {
  t.plan(3)
  const fastify = Fastify()
  t.after(() => fastify.close())

  const results = []
  fastify.get('/', (request, reply) => {
    reply.hijack()
    results.push(reply.trySend({ branch: 'trySend' }))
    reply.raw.end('hijacked')
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.deepStrictEqual(results, [false])
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.body, 'hijacked')
})

test('trySend: client abort mid-flight produces a single response attempt and restores listeners', async t => {
  t.plan(3)
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', (request, reply, payload, done) => {
    onSendCount++
    done()
  })

  const results = []
  let baseline
  let countListeners
  const handlerReady = deferred()
  const settled = deferred()

  fastify.get('/', (request, reply) => {
    const first = deferred()
    const second = deferred()
    first.promise.then(() => {
      results.push(reply.trySend({ branch: 'first' }))
    })
    second.promise.then(() => {
      results.push(reply.trySend({ branch: 'second' }))
    })
    reply.raw.on('close', () => {
      // The client went away before any branch was ready; both
      // branches arrive only after the connection was destroyed.
      first.resolve()
      setImmediate(() => {
        second.resolve()
        setImmediate(() => settled.resolve())
      })
    })
    baseline = {
      reqClose: request.raw.listenerCount('close'),
      resFinish: reply.raw.listenerCount('finish'),
      resError: reply.raw.listenerCount('error'),
      resClose: reply.raw.listenerCount('close')
    }
    countListeners = () => ({
      reqClose: request.raw.listenerCount('close'),
      resFinish: reply.raw.listenerCount('finish'),
      resError: reply.raw.listenerCount('error'),
      resClose: reply.raw.listenerCount('close')
    })
    handlerReady.resolve()
  })

  await fastify.listen({ port: 0 })
  const { port } = fastify.server.address()

  const clientRequest = http.request({ port, path: '/', method: 'GET' })
  clientRequest.on('error', () => {})
  clientRequest.end()
  await handlerReady.promise
  clientRequest.destroy()
  await settled.promise

  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.deepStrictEqual(countListeners(), baseline)
})
