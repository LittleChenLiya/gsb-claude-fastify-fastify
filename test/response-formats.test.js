'use strict'

const { test } = require('node:test')
const Fastify = require('..')

const data = { hello: 'world' }

function textSerializer (payload) {
  return 'hello is ' + payload.hello
}

function buildApp (routeOpts = {}) {
  const fastify = Fastify()
  fastify.get('/data', {
    responseFormats: [
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) },
      { contentType: 'text/plain', serializer: textSerializer }
    ],
    ...routeOpts
  }, async () => data)
  return fastify
}

test('selects application/json for an exact Accept match', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
  t.assert.strictEqual(response.headers.vary, 'Accept')
  t.assert.deepStrictEqual(JSON.parse(response.body), data)
})

test('selects text/plain for an exact Accept match', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
  t.assert.strictEqual(response.headers.vary, 'Accept')
  t.assert.strictEqual(response.body, 'hello is world')
})

test('defaults to the first declared format without an Accept header', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({ method: 'GET', url: '/data' })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
  t.assert.strictEqual(response.headers.vary, 'Accept')
  t.assert.deepStrictEqual(JSON.parse(response.body), data)
})

test('defaults to the first declared format for */*', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: '*/*' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
})

test('matches a type/* wildcard', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/*' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
  t.assert.strictEqual(response.body, 'hello is world')
})

test('honours q-values to pick the preferred format', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=0.1, text/plain;q=0.9' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
  t.assert.strictEqual(response.body, 'hello is world')
})

test('q=0 excludes a format even when a wildcard matches it', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=0, */*;q=0.5' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
  t.assert.strictEqual(response.body, 'hello is world')
})

test('q=0 on every declared format produces a 406', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=0, text/plain;q=0' }
  })

  t.assert.strictEqual(response.statusCode, 406)
  t.assert.strictEqual(response.headers.vary, 'Accept')
  const body = JSON.parse(response.body)
  t.assert.strictEqual(body.statusCode, 406)
  t.assert.strictEqual(body.error, 'Not Acceptable')
})

test('an invalid q-value is treated as not acceptable', async t => {
  const fastify = buildApp()

  const notAcceptable = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=abc' }
  })
  t.assert.strictEqual(notAcceptable.statusCode, 406)

  const outOfRange = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=2' }
  })
  t.assert.strictEqual(outOfRange.statusCode, 406)

  const fallback = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=abc, text/plain' }
  })
  t.assert.strictEqual(fallback.statusCode, 200)
  t.assert.strictEqual(fallback.headers['content-type'], 'text/plain')
})

test('duplicate Accept entries keep the first occurrence', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json;q=0.5, text/plain;q=0.1, text/plain;q=0.9' }
  })

  // the second text/plain entry is ignored, so application/json wins 0.5 vs 0.1
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
})

test('ties are broken by match specificity before declaration order', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/*, application/json' }
  })

  // both weigh 1, but the exact application/json match is more specific
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
})

test('equal q and specificity fall back to the route declaration order', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain, application/json' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')

  const reversed = Fastify()
  reversed.get('/data', {
    responseFormats: [
      { contentType: 'text/plain', serializer: textSerializer },
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) }
    ]
  }, async () => data)
  const reversedResponse = await reversed.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain, application/json' }
  })

  t.assert.strictEqual(reversedResponse.statusCode, 200)
  t.assert.strictEqual(reversedResponse.headers['content-type'], 'text/plain')
})

test('an Accept header matching nothing produces a 406', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/xml' }
  })

  t.assert.strictEqual(response.statusCode, 406)
  t.assert.match(response.headers['content-type'], /application\/json/)
  const body = JSON.parse(response.body)
  t.assert.strictEqual(body.statusCode, 406)
  t.assert.strictEqual(body.error, 'Not Acceptable')
})

test('Accept matching is case-insensitive', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'Application/JSON' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'application/json')
})

test('Accept parameters other than q are ignored', async t => {
  const fastify = buildApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain; charset=utf-8' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers['content-type'], 'text/plain')
})

test('the Accept value is appended to an existing Vary header', async t => {
  const fastify = Fastify()
  fastify.get('/data', {
    responseFormats: [
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) },
      { contentType: 'text/plain', serializer: textSerializer }
    ]
  }, async (request, reply) => {
    reply.header('vary', 'Accept-Encoding')
    return data
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers.vary, 'Accept-Encoding, Accept')
})

test('an existing Vary: Accept is not duplicated', async t => {
  const fastify = Fastify()
  fastify.get('/data', {
    responseFormats: [
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) }
    ]
  }, async (request, reply) => {
    reply.header('vary', 'Accept')
    return data
  })

  const response = await fastify.inject({ method: 'GET', url: '/data' })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.headers.vary, 'Accept')
})

test('a manually set Content-Type takes precedence over negotiation', async t => {
  const fastify = Fastify()
  fastify.get('/data', {
    responseFormats: [
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) },
      { contentType: 'text/plain', serializer: textSerializer }
    ]
  }, async (request, reply) => {
    reply.type('text/plain')
    return 'manual'
  })

  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.match(response.headers['content-type'], /text\/plain/)
  t.assert.strictEqual(response.body, 'manual')
})

test('a failing serializer produces a 500 through the error handler', async t => {
  t.plan(9)

  const fastify = Fastify()
  let preSerializationCalls = 0
  let onSendCalls = 0
  let onErrorCalls = 0

  fastify.addHook('preSerialization', async () => { preSerializationCalls++ })
  fastify.addHook('onSend', async () => { onSendCalls++ })
  fastify.addHook('onError', async () => { onErrorCalls++ })

  fastify.get('/data', {
    responseFormats: [
      { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) },
      {
        contentType: 'text/plain',
        serializer: () => { throw new Error('kaboom') }
      }
    ]
  }, async () => data)

  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain' }
  })

  t.assert.strictEqual(response.statusCode, 500)
  const body = JSON.parse(response.body)
  t.assert.strictEqual(body.statusCode, 500)
  t.assert.strictEqual(body.message, 'kaboom')
  // the failing payload ran preSerialization once and never reached onSend;
  // the 500 error response itself is delivered through onSend
  t.assert.strictEqual(preSerializationCalls, 1)
  t.assert.strictEqual(onErrorCalls, 1)
  t.assert.strictEqual(onSendCalls, 1)

  const healthy = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'application/json' }
  })

  t.assert.strictEqual(healthy.statusCode, 200)
  t.assert.strictEqual(preSerializationCalls, 2)
  t.assert.strictEqual(onSendCalls, 2)
})

test('hooks run exactly once per negotiated response', async t => {
  const fastify = buildApp()
  let preSerializationCalls = 0
  let onSendCalls = 0
  let onResponseCalls = 0

  fastify.addHook('preSerialization', async () => { preSerializationCalls++ })
  fastify.addHook('onSend', async () => { onSendCalls++ })
  fastify.addHook('onResponse', async () => { onResponseCalls++ })

  const response = await fastify.inject({
    method: 'GET',
    url: '/data',
    headers: { accept: 'text/plain' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(preSerializationCalls, 1)
  t.assert.strictEqual(onSendCalls, 1)
  t.assert.strictEqual(onResponseCalls, 1)
})

test('invalid responseFormats options are rejected at route registration', async t => {
  const fastify = Fastify()

  t.assert.throws(() => {
    fastify.get('/a', { responseFormats: [] }, async () => ({}))
  }, /must be a non-empty array/)

  t.assert.throws(() => {
    fastify.get('/b', {
      responseFormats: [{ contentType: 'application/json' }]
    }, async () => ({}))
  }, /must provide a serializer function/)

  t.assert.throws(() => {
    fastify.get('/c', {
      responseFormats: [{ contentType: 'not-a-media-type', serializer: () => '' }]
    }, async () => ({}))
  }, /must declare a concrete contentType/)

  t.assert.throws(() => {
    fastify.get('/d', {
      responseFormats: [
        { contentType: 'application/json', serializer: () => '' },
        { contentType: 'application/json', serializer: () => '' }
      ]
    }, async () => ({}))
  }, /more than once/)

  t.assert.throws(() => {
    fastify.get('/e', {
      responseFormats: [{ contentType: '*/*', serializer: () => '' }]
    }, async () => ({}))
  }, /must declare a concrete contentType/)
})

test('routes without responseFormats are unaffected', async t => {
  const fastify = Fastify()
  fastify.get('/json', async () => data)
  fastify.get('/text', async () => 'plain')

  const json = await fastify.inject({ method: 'GET', url: '/json' })
  t.assert.strictEqual(json.statusCode, 200)
  t.assert.match(json.headers['content-type'], /application\/json/)
  t.assert.strictEqual(json.headers.vary, undefined)

  const text = await fastify.inject({ method: 'GET', url: '/text' })
  t.assert.strictEqual(text.statusCode, 200)
  t.assert.match(text.headers['content-type'], /text\/plain/)
  t.assert.strictEqual(text.headers.vary, undefined)
})
