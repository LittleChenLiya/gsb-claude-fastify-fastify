'use strict'

const { test } = require('node:test')
const zlib = require('node:zlib')
const net = require('node:net')
const http = require('node:http')
const { once } = require('node:events')
const Fastify = require('../fastify')
const { kRequestPayloadStream } = require('../lib/symbols')

const json = JSON.stringify({ hello: 'world' })
const gzippedJson = zlib.gzipSync(json)

function gzipPost (payload, headers = {}, url = '/') {
  return {
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      ...headers
    },
    payload
  }
}

test('decompresses a gzipped JSON body and passes it to the handler', async t => {
  t.plan(4)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    handlerCalls++
    t.assert.deepStrictEqual(request.body, { hello: 'world' })
    reply.send(request.body)
  })

  const res = await fastify.inject(gzipPost(gzippedJson))
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world' })
  t.assert.strictEqual(handlerCalls, 1)
})

test('schema validation runs on the decompressed body', async t => {
  t.plan(2)
  const fastify = Fastify()

  fastify.post('/', {
    decompressBody: true,
    schema: {
      body: {
        type: 'object',
        properties: { hello: { type: 'integer' } }
      }
    }
  }, (request, reply) => reply.send(request.body))

  const res = await fastify.inject(gzipPost(gzippedJson))
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_VALIDATION')
})

test('identity encoding and missing encoding pass through unchanged', async t => {
  t.plan(3)
  const fastify = Fastify()

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    reply.send(request.body)
  })

  const identity = await fastify.inject(gzipPost(json, { 'content-encoding': 'identity' }))
  t.assert.strictEqual(identity.statusCode, 200)
  t.assert.deepStrictEqual(identity.json(), { hello: 'world' })

  const plain = await fastify.inject({
    method: 'POST',
    url: '/',
    headers: { 'content-type': 'application/json' },
    payload: json
  })
  t.assert.strictEqual(plain.statusCode, 200)
})

test('decompressedLimit replies 413 and skips hooks and handler', async t => {
  t.plan(6)
  const fastify = Fastify()
  let handlerCalls = 0
  let preValidationCalls = 0
  let preHandlerCalls = 0

  // tiny when compressed, larger than 1024 bytes when decompressed
  const bomb = zlib.gzipSync(Buffer.alloc(2048, 'a'))
  t.assert.ok(bomb.length < 1024)

  fastify.addHook('preValidation', (request, reply, done) => { preValidationCalls++; done() })
  fastify.addHook('preHandler', (request, reply, done) => { preHandlerCalls++; done() })

  fastify.post('/', {
    decompressBody: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 }
  }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  const res = await fastify.inject(gzipPost(bomb, { 'content-type': 'text/plain' }))
  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_DECOMPRESSED_BODY_TOO_LARGE')
  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(preValidationCalls, 0)
  t.assert.strictEqual(preHandlerCalls, 0)
})

test('compressedLimit replies 413 and skips the handler', async t => {
  t.plan(3)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', {
    decompressBody: { compressedLimit: 8, decompressedLimit: 1024 * 1024 }
  }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  const res = await fastify.inject(gzipPost(gzippedJson))
  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_COMPRESSED_BODY_TOO_LARGE')
  t.assert.strictEqual(handlerCalls, 0)
})

test('bodyLimit still applies to the decompressed parser input', async t => {
  t.plan(2)
  const fastify = Fastify()

  fastify.post('/', {
    bodyLimit: 8,
    decompressBody: { compressedLimit: 1024 * 1024, decompressedLimit: 1024 * 1024 }
  }, (request, reply) => reply.send({ ok: true }))

  const res = await fastify.inject(gzipPost(gzippedJson))
  t.assert.strictEqual(res.statusCode, 413)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_BODY_TOO_LARGE')
})

test('truncated gzip payload replies 400', async t => {
  t.plan(3)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  // drop the last 8 bytes (CRC32 + ISIZE trailer)
  const truncated = gzippedJson.subarray(0, gzippedJson.length - 8)
  const res = await fastify.inject(gzipPost(truncated))
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_GZIP_BODY')
  t.assert.strictEqual(handlerCalls, 0)
})

test('gzip payload with corrupted CRC replies 400', async t => {
  t.plan(3)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  const corrupted = Buffer.from(gzippedJson)
  corrupted[corrupted.length - 5] ^= 0xff
  const res = await fastify.inject(gzipPost(corrupted))
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_INVALID_GZIP_BODY')
  t.assert.strictEqual(handlerCalls, 0)
})

test('unsupported and multi-layer content encodings reply 415', async t => {
  t.plan(9)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  for (const encoding of ['br', 'deflate', 'gzip, br', 'identity, gzip']) {
    const res = await fastify.inject(gzipPost(gzippedJson, { 'content-encoding': encoding }))
    t.assert.strictEqual(res.statusCode, 415, encoding)
    t.assert.strictEqual(res.json().code, 'FST_ERR_CTP_UNSUPPORTED_CONTENT_ENCODING', encoding)
  }
  t.assert.strictEqual(handlerCalls, 0)
})

test('disabled by default: gzipped body keeps the previous behavior', async t => {
  t.plan(3)
  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/', (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  // without decompressBody the raw gzipped bytes reach the JSON parser
  const res = await fastify.inject(gzipPost(gzippedJson))
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.ok(
    res.json().code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    res.json().code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
  )
  t.assert.strictEqual(handlerCalls, 0)
})

test('invalid decompressBody option values are rejected', async t => {
  t.plan(7)
  const invalid = [
    'gzip',
    42,
    [],
    { compressedLimit: -1 },
    { compressedLimit: 1.5 },
    { decompressedLimit: -1 },
    { decompressedLimit: '1024' }
  ]

  for (const decompressBody of invalid) {
    const fastify = Fastify()
    t.assert.throws(
      () => fastify.post('/', { decompressBody }, () => {}),
      { code: 'FST_ERR_ROUTE_DECOMPRESS_BODY_OPTION_INVALID' },
      JSON.stringify(decompressBody)
    )
  }
})

test('route option respects encapsulation and does not leak to the parent scope', async t => {
  t.plan(6)
  const fastify = Fastify()
  let parentHandlerCalls = 0

  fastify.post('/parent', (request, reply) => {
    parentHandlerCalls++
    reply.send(request.body)
  })

  fastify.register(async function (child) {
    child.post('/child', { decompressBody: true }, (request, reply) => {
      reply.send(request.body)
    })
  })

  // parent route without the option keeps the previous behavior
  const parentGzip = await fastify.inject(gzipPost(gzippedJson, {}, '/parent'))
  t.assert.strictEqual(parentGzip.statusCode, 400)
  t.assert.strictEqual(parentHandlerCalls, 0)

  // parent route still parses plain JSON
  const parentPlain = await fastify.inject({
    method: 'POST',
    url: '/parent',
    headers: { 'content-type': 'application/json' },
    payload: json
  })
  t.assert.strictEqual(parentPlain.statusCode, 200)
  t.assert.strictEqual(parentHandlerCalls, 1)

  // child route decompresses
  const child = await fastify.inject({
    method: 'POST',
    url: '/child',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    payload: gzippedJson
  })
  t.assert.strictEqual(child.statusCode, 200)
  t.assert.deepStrictEqual(child.json(), { hello: 'world' })
})

test('streams a chunked gzip body over a real socket', async t => {
  t.plan(3)
  const fastify = Fastify()

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    reply.send(request.body)
  })

  const address = await fastify.listen({ port: 0 })
  t.after(() => fastify.close())
  const { port } = new URL(address)

  const bigBody = JSON.stringify({ data: 'x'.repeat(4096) })
  const gzipped = zlib.gzipSync(bigBody)

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      port,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': gzipped.length
      }
    }, resolve)
    req.on('error', reject)

    let offset = 0
    function writeChunk () {
      while (offset < gzipped.length) {
        const chunk = gzipped.subarray(offset, offset + 7)
        offset += 7
        if (offset < gzipped.length) {
          req.write(chunk, () => setImmediate(writeChunk))
          return
        }
        req.end(chunk)
      }
    }
    writeChunk()
  })

  t.assert.strictEqual(response.statusCode, 200)
  let received = ''
  response.setEncoding('utf8')
  response.on('data', chunk => { received += chunk })
  await once(response, 'end')
  t.assert.deepStrictEqual(JSON.parse(received), { data: 'x'.repeat(4096) })
  t.assert.ok(true)
})

test('client aborting mid-decompression cleans up streams without unhandled errors', async t => {
  t.plan(5)
  const fastify = Fastify()
  let handlerCalls = 0
  let abortedRequest = null

  fastify.addHook('onRequestAbort', (request, done) => {
    abortedRequest = request
    done()
  })

  fastify.post('/', { decompressBody: true }, (request, reply) => {
    handlerCalls++
    reply.send({ ok: true })
  })

  const address = await fastify.listen({ port: 0 })
  t.after(() => fastify.close())
  const { port } = new URL(address)

  const socket = net.connect(Number(port), '127.0.0.1')
  await once(socket, 'connect')

  socket.write(
    'POST / HTTP/1.1\r\n' +
    'Host: localhost\r\n' +
    'Content-Type: application/json\r\n' +
    'Content-Encoding: gzip\r\n' +
    `Content-Length: ${gzippedJson.length}\r\n` +
    '\r\n'
  )
  // send only part of the gzip payload, then hang up mid-decompression
  socket.write(gzippedJson.subarray(0, 10))
  await new Promise(resolve => setTimeout(resolve, 100))
  socket.destroy()

  // eslint-disable-next-line no-unmodified-loop-condition
  for (let i = 0; i < 50 && abortedRequest === null; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  t.assert.ok(abortedRequest, 'onRequestAbort hook was called')

  // give the cleanup a chance to run
  await new Promise(resolve => setTimeout(resolve, 100))

  const payloadStream = abortedRequest[kRequestPayloadStream]
  t.assert.ok(payloadStream.destroyed, 'decompression stream is destroyed')
  t.assert.strictEqual(abortedRequest.raw.listenerCount('data'), 0, 'no residual data listeners on the raw request')
  t.assert.strictEqual(payloadStream.listenerCount('data'), 0, 'no residual data listeners on the decompression stream')
  t.assert.strictEqual(handlerCalls, 0, 'handler was not called')
})
