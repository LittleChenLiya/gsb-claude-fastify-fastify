'use strict'

const { test } = require('node:test')
const zlib = require('node:zlib')
const net = require('node:net')
const http = require('node:http')
const Fastify = require('../fastify')

const json = JSON.stringify({ hello: 'world' })
const gzipped = zlib.gzipSync(json)

function gzip (value) {
  return zlib.gzipSync(value)
}

function gzipHeaders (extra) {
  return Object.assign({ 'content-type': 'application/json', 'content-encoding': 'gzip' }, extra)
}

test('decompresses a gzip JSON body and passes it to the handler and schema validation', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 } })
  t.after(() => fastify.close())

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: { hello: { type: 'string' } },
        required: ['hello']
      }
    }
  }, (request, reply) => {
    reply.send({ received: request.body })
  })

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: gzipped
  })

  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { received: { hello: 'world' } })

  const invalid = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: gzip(JSON.stringify({ unexpected: true }))
  })

  t.assert.strictEqual(invalid.statusCode, 400)
})

test('identity and missing content-encoding pass through unchanged', async t => {
  const fastify = Fastify({ requestDecompression: true })
  t.after(() => fastify.close())

  fastify.post('/', (request, reply) => { reply.send(request.body) })

  for (const headers of [
    { 'content-type': 'application/json' },
    { 'content-type': 'application/json', 'content-encoding': 'identity' }
  ]) {
    const res = await fastify.inject({ method: 'POST', url: '/', headers, payload: json })
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), { hello: 'world' })
  }
})

test('decompressed output over the limit returns 413 and the handler is not called', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 } })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  // compresses to a few bytes, expands well past 1024 bytes
  const payload = gzip(JSON.stringify({ pad: 'x'.repeat(2048) }))
  t.assert.ok(payload.length < 1024)

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload
  })

  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_BODY_TOO_LARGE')
  t.assert.strictEqual(handlerCalls, 0)
})

test('compressed input over the limit returns 413 and the handler is not called', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 16, decompressedLimit: 1024 * 1024 } })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: gzipped
  })

  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_BODY_TOO_LARGE')
  t.assert.strictEqual(handlerCalls, 0)
})

test('truncated gzip body returns 400 and the handler is not called', async t => {
  const fastify = Fastify({ requestDecompression: true })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  const truncated = gzipped.subarray(0, gzipped.length - 8)
  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders({ 'content-length': String(truncated.length) }),
    payload: truncated
  })

  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_GZIP_BODY')
  t.assert.strictEqual(handlerCalls, 0)
})

test('gzip body with a corrupt CRC returns 400', async t => {
  const fastify = Fastify({ requestDecompression: true })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  const corrupted = Buffer.from(gzipped)
  corrupted[corrupted.length - 5] ^= 0xff

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: corrupted
  })

  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_GZIP_BODY')
  t.assert.strictEqual(handlerCalls, 0)
})

test('unknown and multi-layer content-encodings return 415', async t => {
  const fastify = Fastify({ requestDecompression: true })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  for (const encoding of ['br', 'deflate', 'gzip, gzip', 'gzip, br']) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'content-encoding': encoding },
      payload: gzipped
    })

    t.assert.strictEqual(res.statusCode, 415, encoding)
    t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_CONTENT_ENCODING')
  }

  t.assert.strictEqual(handlerCalls, 0)
})

test('decompression failures do not enter preValidation, preHandler or handler', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 } })
  t.after(() => fastify.close())

  const calls = { preValidation: 0, preHandler: 0, handler: 0 }
  fastify.post('/', {
    preValidation: (request, reply, done) => { calls.preValidation++; done() },
    preHandler: (request, reply, done) => { calls.preHandler++; done() }
  }, (request, reply) => {
    calls.handler++
    reply.send(request.body)
  })

  const cases = [
    { headers: gzipHeaders(), payload: gzip(JSON.stringify({ pad: 'x'.repeat(2048) })) },
    { headers: gzipHeaders(), payload: gzipped.subarray(0, gzipped.length - 8) },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'br' }, payload: gzipped }
  ]

  for (const testCase of cases) {
    await fastify.inject({ method: 'POST', url: '/', headers: testCase.headers, payload: testCase.payload })
  }

  t.assert.deepStrictEqual(calls, { preValidation: 0, preHandler: 0, handler: 0 })
})

test('bodyLimit still applies to the decompressed parser input', async t => {
  const fastify = Fastify({
    bodyLimit: 64,
    requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 }
  })
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: gzip(JSON.stringify({ pad: 'x'.repeat(128) }))
  })

  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(handlerCalls, 0)
})

test('decompression is disabled by default and the original behavior is kept', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  let handlerCalls = 0
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  const res = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: gzipHeaders(),
    payload: gzipped
  })

  // the gzip bytes reach the JSON parser as-is and fail to parse
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_CONTENT_LENGTH')
  t.assert.strictEqual(handlerCalls, 0)
})

test('route option and limits follow the encapsulation scope', async t => {
  const fastify = Fastify()
  t.after(() => fastify.close())

  const bodies = []
  fastify.post('/parent', (request, reply) => {
    bodies.push(request.body)
    reply.send(request.body)
  })

  fastify.register(async function (child) {
    child.post('/child', {
      decompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 }
    }, (request, reply) => {
      reply.send({ child: request.body })
    })
  })

  const childRes = await fastify.inject({
    method: 'POST',
    url: '/child',
    headers: gzipHeaders(),
    payload: gzipped
  })
  t.assert.strictEqual(childRes.statusCode, 200)
  t.assert.deepStrictEqual(childRes.json(), { child: { hello: 'world' } })

  // the parent scope is not affected by the child route option
  const parentRes = await fastify.inject({
    method: 'POST',
    url: '/parent',
    headers: gzipHeaders(),
    payload: gzipped
  })
  t.assert.strictEqual(parentRes.statusCode, 400)
  t.assert.strictEqual(parentRes.json().code, 'FST_ERR_CTP_INVALID_CONTENT_LENGTH')
  t.assert.strictEqual(bodies.length, 0)
})

test('instance option is inherited by encapsulated contexts and can be overridden per route', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 128 } })
  t.after(() => fastify.close())

  fastify.register(async function (child) {
    // inherits the instance level configuration
    child.post('/inherited', (request, reply) => { reply.send(request.body) })
    // disabled for this route only
    child.post('/disabled', { decompression: false }, (request, reply) => { reply.send(request.body) })
    // looser limit for this route only
    child.post('/override', { decompression: { decompressedLimit: 1024 * 1024 } }, (request, reply) => {
      reply.send(request.body)
    })
  })

  const big = gzip(JSON.stringify({ pad: 'x'.repeat(256) }))

  const inherited = await fastify.inject({ method: 'POST', url: '/inherited', headers: gzipHeaders(), payload: big })
  t.assert.strictEqual(inherited.statusCode, 413)

  const disabled = await fastify.inject({ method: 'POST', url: '/disabled', headers: gzipHeaders(), payload: gzipped })
  t.assert.strictEqual(disabled.statusCode, 400)
  t.assert.strictEqual(disabled.json().code, 'FST_ERR_CTP_INVALID_CONTENT_LENGTH')

  const override = await fastify.inject({ method: 'POST', url: '/override', headers: gzipHeaders(), payload: big })
  t.assert.strictEqual(override.statusCode, 200)
  t.assert.deepStrictEqual(override.json(), { pad: 'x'.repeat(256) })
})

test('invalid decompression options are rejected', async t => {
  t.assert.throws(
    () => Fastify({ requestDecompression: { compressedLimit: -1 } }),
    /FST_ERR_INIT_OPTS_INVALID/
  )
  t.assert.throws(
    () => Fastify({ requestDecompression: 'gzip' }),
    /FST_ERR_INIT_OPTS_INVALID/
  )

  const fastify = Fastify()
  t.after(() => fastify.close())

  t.assert.throws(
    () => fastify.post('/a', { decompression: 'gzip' }, () => {}),
    /FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID/
  )
  t.assert.throws(
    () => fastify.post('/b', { decompression: { decompressedLimit: 1.5 } }, () => {}),
    /FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID/
  )
  t.assert.throws(
    () => fastify.post('/c', { decompression: { compressedLimit: -1 } }, () => {}),
    /FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID/
  )
})

test('decompresses a streamed gzip body sent in chunks over a real socket', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 } })
  t.after(() => fastify.close())

  fastify.post('/', (request, reply) => { reply.send({ received: request.body }) })

  await fastify.listen({ port: 0 })
  const port = fastify.server.address().port

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      port,
      path: '/',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }
    }, resolve)
    req.on('error', reject)
    // no content-length: the body is streamed with chunked transfer encoding
    for (let i = 0; i < gzipped.length; i += 5) {
      req.write(gzipped.subarray(i, i + 5))
    }
    req.end()
  })

  let body = ''
  for await (const chunk of response) {
    body += chunk
  }

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(body), { received: { hello: 'world' } })
})

test('client abort during decompression cleans up streams without unhandled errors', async t => {
  const fastify = Fastify({ requestDecompression: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 } })
  t.after(() => fastify.close())

  let rawRequest = null
  let handlerCalls = 0
  fastify.addHook('onRequest', (request, reply, done) => {
    rawRequest = request.raw
    done()
  })
  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send(request.body)
  })

  await fastify.listen({ port: 0 })
  const port = fastify.server.address().port

  let uncaught = null
  const onUncaught = (err) => { uncaught = err }
  process.once('uncaughtException', onUncaught)
  t.after(() => { process.removeListener('uncaughtException', onUncaught) })

  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'POST / HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Encoding: gzip\r\n' +
        'Content-Length: 1048576\r\n' +
        'Connection: close\r\n' +
        '\r\n'
      )
      // send only the first part of the gzip stream, then go away
      socket.write(gzipped.subarray(0, 10), () => {
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 50)
      })
    })
    socket.on('error', reject)
  })

  // give the server time to observe the abort and run the cleanup
  await new Promise(resolve => setTimeout(resolve, 200))

  t.assert.strictEqual(uncaught, null)
  t.assert.strictEqual(handlerCalls, 0)
  t.assert.ok(rawRequest)
  t.assert.strictEqual(rawRequest.listenerCount('close'), 0)

  // the server is still able to serve requests on a new connection
  const res = await fastify.inject({ method: 'POST', url: '/', headers: gzipHeaders(), payload: gzipped })
  t.assert.strictEqual(res.statusCode, 200)
})
