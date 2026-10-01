'use strict'

const { test } = require('node:test')
const net = require('node:net')
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

async function poll (condition, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('condition not met in time')
}

test('trySend: first branch wins, second gets false, onSend runs once', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  const onSendGate = deferred()
  fastify.addHook('onSend', async function (request, reply, payload) {
    onSendCount++
    // keep the winning branch inside the onSend hook, so the losing
    // branch arrives while the send pipeline is still in progress
    await onSendGate.promise
  })

  const branchA = deferred()
  const branchB = deferred()
  const results = []

  fastify.get('/', function (request, reply) {
    branchA.promise.then((payload) => { results.push(reply.trySend(payload)) })
    branchB.promise.then((payload) => { results.push(reply.trySend(payload)) })
  })

  const responsePromise = fastify.inject({ method: 'GET', url: '/' })

  branchA.resolve('first')
  await poll(() => onSendCount === 1)
  // branch B arrives while branch A is still inside the onSend hook
  branchB.resolve('second')
  await poll(() => results.length === 2)
  onSendGate.resolve()

  const res = await responsePromise
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.body, 'first')
})

test('trySend: serialization error is routed to the error handler, single response', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let errorHandlerCalls = 0
  let onSendCount = 0
  fastify.setErrorHandler(function (error, request, reply) {
    errorHandlerCalls++
    t.assert.strictEqual(error.message, 'kaboom')
    reply.code(500).send({ error: 'handled' })
  })
  fastify.addHook('onSend', function (request, reply, payload, done) {
    onSendCount++
    done()
  })

  const branchB = deferred()
  const results = []

  fastify.get('/', function (request, reply) {
    let shouldThrow = true
    reply.serializer(function (payload) {
      if (shouldThrow) {
        shouldThrow = false
        throw new Error('kaboom')
      }
      return JSON.stringify(payload)
    })
    results.push(reply.trySend({ hello: 'world' }))
    branchB.promise.then((payload) => { results.push(reply.trySend(payload)) })
  })

  const responsePromise = fastify.inject({ method: 'GET', url: '/' })
  branchB.resolve('second')

  const res = await responsePromise
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(errorHandlerCalls, 1)
  // only the error handler payload reaches the onSend hook
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(res.statusCode, 500)
  t.assert.deepStrictEqual(res.json(), { error: 'handled' })
})

test('trySend: returns false when a previous send() is still in progress', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  const onSendGate = deferred()
  fastify.addHook('onSend', async function (request, reply, payload) {
    onSendCount++
    await onSendGate.promise
  })

  const results = []

  fastify.get('/', function (request, reply) {
    reply.send('first')
    // the previous send() is still inside the async onSend hook
    results.push(reply.trySend('second'))
  })

  const responsePromise = fastify.inject({ method: 'GET', url: '/' })
  await poll(() => results.length === 1)
  onSendGate.resolve()

  const res = await responsePromise
  t.assert.deepStrictEqual(results, [false])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.body, 'first')
})

test('trySend: a later send() does not produce a second response', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', function (request, reply, payload, done) {
    onSendCount++
    done()
  })

  const results = []

  fastify.get('/', function (request, reply) {
    results.push(reply.trySend('first'))
    reply.send('second')
  })

  const res = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.deepStrictEqual(results, [true])
  t.assert.strictEqual(onSendCount, 1)
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.body, 'first')
})

test('trySend: client abort after the winning response, listeners are cleaned up', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  let onResponseCount = 0
  fastify.addHook('onSend', function (request, reply, payload, done) {
    onSendCount++
    done()
  })
  fastify.addHook('onResponse', function (request, reply, done) {
    onResponseCount++
    done()
  })

  const branchA = deferred()
  const branchB = deferred()
  const results = []
  let replyRef

  fastify.get('/', function (request, reply) {
    replyRef = reply
    branchA.promise.then((payload) => { results.push(reply.trySend(payload)) })
    branchB.promise.then((payload) => { results.push(reply.trySend(payload)) })
  })

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const port = fastify.server.address().port

  const socket = net.connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  await poll(() => replyRef !== undefined)

  branchA.resolve('first')
  const response = await new Promise((resolve) => {
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (received.includes('first')) resolve(received)
    })
  })
  t.assert.ok(response.includes('first'))

  // the client goes away after the winning response was sent
  socket.destroy()

  // the losing branch arrives after the response has been sent
  branchB.resolve('second')
  await poll(() => results.length === 2)

  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)

  // the response lifecycle completed and its listeners were removed
  await poll(() => onResponseCount === 1)
  const finishListenerNames = replyRef.raw.listeners('finish').map((fn) => fn.name)
  const errorListenerNames = replyRef.raw.listeners('error').map((fn) => fn.name)
  t.assert.ok(!finishListenerNames.includes('onResFinished'))
  t.assert.ok(!errorListenerNames.includes('onResFinished'))
})

test('trySend: client abort before any branch resolves, single send pipeline', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let onSendCount = 0
  fastify.addHook('onSend', function (request, reply, payload, done) {
    onSendCount++
    done()
  })
  fastify.addHook('onResponse', function (request, reply, done) {
    done()
  })

  const branchA = deferred()
  const branchB = deferred()
  const results = []
  let replyRef

  fastify.get('/', function (request, reply) {
    replyRef = reply
    branchA.promise.then((payload) => { results.push(reply.trySend(payload)) })
    branchB.promise.then((payload) => { results.push(reply.trySend(payload)) })
  })

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const port = fastify.server.address().port

  const socket = net.connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  await poll(() => replyRef !== undefined)

  // the client goes away before any branch produced a result
  socket.destroy()
  await poll(() => replyRef.raw.destroyed)

  branchA.resolve('first')
  branchB.resolve('second')
  await poll(() => results.length === 2)

  // only one branch claims the reply and triggers the send pipeline
  t.assert.deepStrictEqual(results, [true, false])
  t.assert.strictEqual(onSendCount, 1)
})
