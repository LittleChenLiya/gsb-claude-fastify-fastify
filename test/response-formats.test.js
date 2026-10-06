'use strict'

const { test } = require('node:test')
const Fastify = require('..')

const payload = { hello: 'world' }

const jsonSerializer = (input) => JSON.stringify(input)
const textSerializer = (input) => `hello=${input.hello}`

function build (routeOptions, handler) {
  const fastify = Fastify()
  fastify.get('/', routeOptions, handler || (async () => payload))
  return fastify
}

const defaultFormats = {
  'application/json': jsonSerializer,
  'text/plain': textSerializer
}

test('exact match selects application/json', async t => {
  t.plan(5)
  const fastify = build({ formats: defaultFormats })

  const res = await fastify.inject({ url: '/', headers: { accept: 'application/json' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'application/json')
  t.assert.strictEqual(res.headers.vary, 'Accept')
  t.assert.strictEqual(res.body, JSON.stringify(payload))
  t.assert.deepStrictEqual(res.json(), payload)
})

test('exact match selects text/plain', async t => {
  t.plan(3)
  const fastify = build({ formats: defaultFormats })

  const res = await fastify.inject({ url: '/', headers: { accept: 'text/plain' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'text/plain')
  t.assert.strictEqual(res.body, 'hello=world')
})

test('higher q-value wins over declaration order', async t => {
  t.plan(3)
  const fastify = build({ formats: defaultFormats })

  const res = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json;q=0.4, text/plain;q=0.9' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'text/plain')
  t.assert.strictEqual(res.body, 'hello=world')
})

test('tie on q is broken by match specificity', async t => {
  t.plan(4)
  const fastify = build({ formats: defaultFormats })

  // text/* is more specific than */*, so text/plain wins the tie
  const typeWildcard = await fastify.inject({
    url: '/',
    headers: { accept: 'text/*;q=0.5, */*;q=0.5' }
  })
  t.assert.strictEqual(typeWildcard.headers['content-type'], 'text/plain')

  // the exact match is more specific than */*, so application/json wins
  const exact = await fastify.inject({
    url: '/',
    headers: { accept: '*/*;q=0.5, application/json;q=0.5' }
  })
  t.assert.strictEqual(exact.headers['content-type'], 'application/json')

  // same specificity and same q, declaration order decides (json declared first)
  const declared = await fastify.inject({
    url: '/',
    headers: { accept: 'text/*;q=0.5, application/*;q=0.5' }
  })
  t.assert.strictEqual(declared.headers['content-type'], 'application/json')
  t.assert.strictEqual(declared.statusCode, 200)
})

test('tie on q and specificity uses route declaration order', async t => {
  t.plan(4)
  const jsonFirst = build({
    formats: [
      { contentType: 'application/json', serializer: jsonSerializer },
      { contentType: 'text/plain', serializer: textSerializer }
    ]
  })
  const textFirst = build({
    formats: [
      { contentType: 'text/plain', serializer: textSerializer },
      { contentType: 'application/json', serializer: jsonSerializer }
    ]
  })
  const headers = { accept: 'application/json, text/plain' }

  const jsonRes = await jsonFirst.inject({ url: '/', headers })
  t.assert.strictEqual(jsonRes.headers['content-type'], 'application/json')
  t.assert.strictEqual(jsonRes.body, JSON.stringify(payload))

  const textRes = await textFirst.inject({ url: '/', headers })
  t.assert.strictEqual(textRes.headers['content-type'], 'text/plain')
  t.assert.strictEqual(textRes.body, 'hello=world')
})

test('q=0 excludes a format even when a wildcard also matches', async t => {
  t.plan(6)
  const fastify = build({ formats: defaultFormats })

  // exact q=0 beats the */* wildcard for application/json
  const excluded = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json;q=0, */*;q=0.8' }
  })
  t.assert.strictEqual(excluded.statusCode, 200)
  t.assert.strictEqual(excluded.headers['content-type'], 'text/plain')

  // type/* q=0 beats */* for text/plain
  const typeExcluded = await fastify.inject({
    url: '/',
    headers: { accept: 'text/*;q=0, */*;q=1' }
  })
  t.assert.strictEqual(typeExcluded.statusCode, 200)
  t.assert.strictEqual(typeExcluded.headers['content-type'], 'application/json')

  // everything excluded -> 406
  const nothing = await fastify.inject({
    url: '/',
    headers: { accept: '*/*;q=0' }
  })
  t.assert.strictEqual(nothing.statusCode, 406)
  t.assert.strictEqual(nothing.json().code, 'FST_ERR_REP_NOT_ACCEPTABLE')
})

test('invalid q-values are treated as not acceptable', async t => {
  t.plan(8)
  const fastify = build({ formats: defaultFormats })

  for (const invalid of ['q=abc', 'q=2', 'q=0.1234', 'q=1.5', 'q=']) {
    const res = await fastify.inject({
      url: '/',
      headers: { accept: `application/json;${invalid}` }
    })
    // application/json is not acceptable and nothing else is offered
    t.assert.strictEqual(res.statusCode, 406, `accept with ${invalid} must be rejected`)
  }

  // the invalid entry is ignored for json, text/plain is still picked
  const fallback = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json;q=abc, text/plain' }
  })
  t.assert.strictEqual(fallback.statusCode, 200)
  t.assert.strictEqual(fallback.headers['content-type'], 'text/plain')

  // valid boundary q-values still work
  const valid = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json;q=1.000, text/plain;q=0.000' }
  })
  t.assert.strictEqual(valid.headers['content-type'], 'application/json')
})

test('duplicate accept entries are resolved by first occurrence', async t => {
  t.plan(4)
  const fastify = build({ formats: defaultFormats })

  // the first application/json entry (q=1) governs, duplicates are ignored
  const res = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json, application/json;q=0.1, text/plain;q=0.5' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'application/json')

  // a duplicated exclusion stays an exclusion
  const excluded = await fastify.inject({
    url: '/',
    headers: { accept: 'application/json;q=0, application/json;q=0.9, text/plain;q=0.3' }
  })
  t.assert.strictEqual(excluded.statusCode, 200)
  t.assert.strictEqual(excluded.headers['content-type'], 'text/plain')
})

test('missing Accept header uses the first declared format', async t => {
  t.plan(4)
  const fastify = build({ formats: defaultFormats })

  const res = await fastify.inject({ url: '/' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'application/json')
  t.assert.strictEqual(res.body, JSON.stringify(payload))

  const wildcard = await fastify.inject({ url: '/', headers: { accept: '*/*' } })
  t.assert.strictEqual(wildcard.headers['content-type'], 'application/json')
})

test('unacceptable requests are answered with 406', async t => {
  t.plan(5)
  const fastify = build({ formats: defaultFormats })

  const res = await fastify.inject({ url: '/', headers: { accept: 'image/png' } })
  t.assert.strictEqual(res.statusCode, 406)
  t.assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = res.json()
  t.assert.strictEqual(body.statusCode, 406)
  t.assert.strictEqual(body.error, 'Not Acceptable')
  t.assert.strictEqual(body.code, 'FST_ERR_REP_NOT_ACCEPTABLE')
})

test('an existing Vary header is preserved and extended', async t => {
  t.plan(5)
  const fastify = build({
    formats: defaultFormats
  }, async (request, reply) => {
    reply.header('vary', 'Accept-Encoding')
    return payload
  })

  const res = await fastify.inject({ url: '/', headers: { accept: 'text/plain' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'text/plain')
  t.assert.ok(res.headers.vary.includes('Accept-Encoding'), 'keeps the user defined Vary value')
  t.assert.ok(res.headers.vary.includes('Accept'), 'appends Accept to Vary')

  // Vary: Accept is not duplicated when the user already set it
  const fastify2 = build({ formats: defaultFormats }, async (request, reply) => {
    reply.header('vary', 'Accept')
    return payload
  })
  const res2 = await fastify2.inject({ url: '/' })
  t.assert.strictEqual(res2.headers.vary, 'Accept')
})

test('a throwing serializer produces a 500 through the error handler', async t => {
  t.plan(5)
  const fastify = Fastify()
  let customErrorHandlerCalls = 0
  fastify.setErrorHandler((error, request, reply) => {
    customErrorHandlerCalls++
    reply.code(500).send({ failed: true, message: error.message })
  })
  fastify.get('/', {
    formats: {
      'application/json': () => { throw new Error('kaboom') },
      'text/plain': textSerializer
    }
  }, async () => payload)

  const res = await fastify.inject({ url: '/', headers: { accept: 'application/json' } })
  t.assert.strictEqual(res.statusCode, 500)
  t.assert.strictEqual(customErrorHandlerCalls, 1)
  t.assert.deepStrictEqual(res.json(), { failed: true, message: 'kaboom' })

  // the other format keeps working
  const ok = await fastify.inject({ url: '/', headers: { accept: 'text/plain' } })
  t.assert.strictEqual(ok.statusCode, 200)
  t.assert.strictEqual(ok.body, 'hello=world')
})

test('lifecycle hooks run exactly once per negotiated request', async t => {
  t.plan(7)
  const fastify = Fastify()
  const calls = {
    onRequest: 0,
    preHandler: 0,
    preSerialization: 0,
    onSend: 0,
    onResponse: 0
  }
  fastify.addHook('onRequest', (request, reply, done) => { calls.onRequest++; done() })
  fastify.addHook('preHandler', (request, reply, done) => { calls.preHandler++; done() })
  fastify.addHook('preSerialization', (request, reply, body, done) => { calls.preSerialization++; done(null, body) })
  fastify.addHook('onSend', (request, reply, body, done) => { calls.onSend++; done(null, body) })
  fastify.addHook('onResponse', (request, reply, done) => { calls.onResponse++; done() })
  fastify.get('/', { formats: defaultFormats }, async () => payload)

  const res = await fastify.inject({ url: '/', headers: { accept: 'text/plain' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.body, 'hello=world')
  t.assert.strictEqual(calls.onRequest, 1)
  t.assert.strictEqual(calls.preHandler, 1)
  t.assert.strictEqual(calls.preSerialization, 1)
  t.assert.strictEqual(calls.onSend, 1)
  t.assert.strictEqual(calls.onResponse, 1)
})

test('hooks run exactly once for a 406 response', async t => {
  t.plan(6)
  const fastify = Fastify()
  const calls = { onRequest: 0, preHandler: 0, onSend: 0, onResponse: 0 }
  fastify.addHook('onRequest', (request, reply, done) => { calls.onRequest++; done() })
  fastify.addHook('preHandler', (request, reply, done) => { calls.preHandler++; done() })
  fastify.addHook('onSend', (request, reply, body, done) => { calls.onSend++; done(null, body) })
  fastify.addHook('onResponse', (request, reply, done) => { calls.onResponse++; done() })
  fastify.get('/', { formats: defaultFormats }, async () => payload)

  const res = await fastify.inject({ url: '/', headers: { accept: 'image/png' } })
  t.assert.strictEqual(res.statusCode, 406)
  t.assert.strictEqual(calls.onRequest, 1)
  t.assert.strictEqual(calls.preHandler, 1)
  t.assert.strictEqual(calls.onSend, 1)
  t.assert.strictEqual(calls.onResponse, 1)
  t.assert.strictEqual(res.json().statusCode, 406)
})

test('the negotiated format and reason are exposed on the request', async t => {
  t.plan(8)
  const fastify = Fastify()
  const seen = []
  fastify.addHook('onSend', (request, reply, body, done) => {
    seen.push(request.negotiatedFormat)
    done(null, body)
  })
  fastify.get('/', { formats: defaultFormats }, async () => payload)

  await fastify.inject({ url: '/', headers: { accept: 'application/json' } })
  t.assert.strictEqual(seen[0].contentType, 'application/json')
  t.assert.strictEqual(seen[0].match, 'exact')
  t.assert.strictEqual(seen[0].q, 1)
  t.assert.ok(seen[0].reason.includes('application/json'), 'reason explains the match')

  await fastify.inject({ url: '/', headers: { accept: 'text/*;q=0.5' } })
  t.assert.strictEqual(seen[1].contentType, 'text/plain')
  t.assert.strictEqual(seen[1].match, 'type')
  t.assert.ok(seen[1].reason.includes('text/*'), 'reason mentions the matched range')

  await fastify.inject({ url: '/' })
  t.assert.strictEqual(seen[2].match, 'default')
})

test('an explicit content-type skips the negotiation', async t => {
  t.plan(4)
  const fastify = Fastify()
  let seen = 'unset'
  fastify.addHook('onSend', (request, reply, body, done) => {
    seen = request.negotiatedFormat
    done(null, body)
  })
  fastify.get('/', { formats: defaultFormats }, async (request, reply) => {
    reply.type('text/html')
    return '<h1>hello</h1>'
  })

  const res = await fastify.inject({ url: '/', headers: { accept: 'application/json' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'text/html')
  t.assert.strictEqual(res.body, '<h1>hello</h1>')
  t.assert.strictEqual(seen, null, 'no negotiation happened')
})

test('a custom reply serializer skips the negotiation', async t => {
  t.plan(3)
  const fastify = Fastify()
  fastify.get('/', { formats: defaultFormats }, async (request, reply) => {
    reply.serializer((input) => 'custom:' + JSON.stringify(input))
    return payload
  })

  const res = await fastify.inject({ url: '/', headers: { accept: 'text/plain' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], undefined, 'the negotiated content-type is not applied')
  t.assert.strictEqual(res.body, 'custom:' + JSON.stringify(payload))
})

test('formats declared as an array keep the declaration order', async t => {
  t.plan(4)
  const fastify = build({
    formats: [
      { contentType: 'text/plain', serializer: textSerializer },
      { contentType: 'application/json', serializer: jsonSerializer }
    ]
  })

  const noAccept = await fastify.inject({ url: '/' })
  t.assert.strictEqual(noAccept.headers['content-type'], 'text/plain')
  t.assert.strictEqual(noAccept.body, 'hello=world')

  const json = await fastify.inject({ url: '/', headers: { accept: 'application/json' } })
  t.assert.strictEqual(json.headers['content-type'], 'application/json')
  t.assert.strictEqual(json.body, JSON.stringify(payload))
})

test('invalid formats options are rejected at registration time', async t => {
  t.plan(7)
  const invalidOptions = [
    ['a string', { formats: 'application/json' }],
    ['an empty array', { formats: [] }],
    ['a missing serializer', { formats: { 'application/json': 42 } }],
    ['a duplicate media type', {
      formats: [
        { contentType: 'application/json', serializer: jsonSerializer },
        { contentType: 'application/json; charset=utf-8', serializer: jsonSerializer }
      ]
    }],
    ['a wildcard media type', { formats: { 'text/*': textSerializer } }],
    ['a malformed media type', { formats: { notamediatype: textSerializer } }],
    ['a non object entry', { formats: ['application/json'] }]
  ]

  for (const [label, routeOptions] of invalidOptions) {
    const fastify = Fastify()
    t.assert.throws(
      () => fastify.get('/', routeOptions, async () => payload),
      (error) => error.code === 'FST_ERR_ROUTE_INVALID_RESPONSE_FORMATS',
      `must reject ${label}`
    )
  }
})

test('formats work with a schema-validated handler and POST bodies', async t => {
  t.plan(3)
  const fastify = Fastify()
  fastify.post('/echo', {
    formats: defaultFormats,
    schema: {
      body: {
        type: 'object',
        properties: { hello: { type: 'string' } }
      }
    }
  }, async (request) => request.body)

  const res = await fastify.inject({
    method: 'POST',
    url: '/echo',
    headers: { accept: 'text/plain', 'content-type': 'application/json' },
    body: { hello: 'world' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'text/plain')
  t.assert.strictEqual(res.body, 'hello=world')
})
