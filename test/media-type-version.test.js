'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const { parseAcceptHeader } = require('../lib/media-type-version-strategy')

const MEDIA_TYPE = 'application/vnd.demo+json'

function build (options) {
  const fastify = Fastify({
    mediaTypeVersioning: Object.assign({ defaultVersion: '1', versionPriority: ['2', '1'] }, options)
  })
  const calls = { v1: 0, v2: 0 }
  fastify.get('/demo', { apiVersion: '1', mediaType: MEDIA_TYPE }, (req, reply) => {
    calls.v1++
    reply.send({ version: 'v1' })
  })
  fastify.get('/demo', { apiVersion: '2', mediaType: MEDIA_TYPE }, (req, reply) => {
    calls.v2++
    reply.send({ version: 'v2' })
  })
  return { fastify, calls }
}

test('acceptance: high q selects v1, equal q selects v2 by priority, q=0 is excluded', async (t) => {
  const { fastify, calls } = build()
  t.after(() => fastify.close())

  const requests = [
    { accept: MEDIA_TYPE + ';version=1;q=0.9, ' + MEDIA_TYPE + ';version=2;q=0.8', expect: 'v1' },
    { accept: MEDIA_TYPE + ';version=1;q=0.8, ' + MEDIA_TYPE + ';version=2;q=0.8', expect: 'v2' },
    { accept: MEDIA_TYPE + ';version=1;q=0, ' + MEDIA_TYPE + ';version=2;q=0.8', expect: 'v2' }
  ]

  for (const { accept, expect } of requests) {
    const headers = { accept }
    const res = await fastify.inject({ method: 'GET', url: '/demo', headers })
    const version = res.statusCode === 200 ? JSON.parse(res.payload).version : null
    console.log('request headers: %j | status: %d | version: %s', headers, res.statusCode, version)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.strictEqual(version, expect)
  }

  t.assert.strictEqual(calls.v1, 1)
  t.assert.strictEqual(calls.v2, 2)
})

test('selection does not execute candidate handlers', async (t) => {
  const { fastify, calls } = build()
  t.after(() => fastify.close())

  const before = calls.v1 + calls.v2
  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=2' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(calls.v1 + calls.v2 - before, 1)
  t.assert.strictEqual(calls.v2, 1)
})

test('comma hidden inside a quoted parameter value does not split entries', async (t) => {
  const { fastify } = build()
  t.after(() => fastify.close())

  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';note="a,b";version=2' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(res.payload), { version: 'v2' })
})

test('quoted version parameter is unquoted', async (t) => {
  const { fastify } = build()
  t.after(() => fastify.close())

  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version="2"' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(res.payload), { version: 'v2' })
})

test('duplicated version parameter answers 400', async (t) => {
  const { fastify, calls } = build()
  t.after(() => fastify.close())

  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=1;version=2' }
  })
  t.assert.strictEqual(res.statusCode, 400)
  t.assert.strictEqual(JSON.parse(res.payload).code, 'FST_ERR_ACCEPT_HEADER_INVALID')
  t.assert.strictEqual(res.headers.vary, 'Accept')
  t.assert.strictEqual(calls.v1 + calls.v2, 0)
})

test('invalid q value answers 400', async (t) => {
  const { fastify, calls } = build()
  t.after(() => fastify.close())

  for (const q of ['abc', '2', '1.5', '-0.1']) {
    const res = await fastify.inject({
      method: 'GET',
      url: '/demo',
      headers: { accept: MEDIA_TYPE + ';version=1;q=' + q }
    })
    t.assert.strictEqual(res.statusCode, 400, 'q=' + q)
    t.assert.strictEqual(JSON.parse(res.payload).code, 'FST_ERR_ACCEPT_HEADER_INVALID')
  }
  t.assert.strictEqual(calls.v1 + calls.v2, 0)
})

test('missing Accept header uses the configured default version', async (t) => {
  const { fastify } = build()
  t.after(() => fastify.close())

  const res = await fastify.inject({ method: 'GET', url: '/demo' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(res.payload), { version: 'v1' })
})

test('no acceptable route answers 406, unknown path answers 404', async (t) => {
  const { fastify } = build()
  t.after(() => fastify.close())

  const notAcceptable = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.other+json' }
  })
  t.assert.strictEqual(notAcceptable.statusCode, 406)
  t.assert.strictEqual(JSON.parse(notAcceptable.payload).code, 'FST_ERR_NO_ACCEPTABLE_VERSION')
  t.assert.strictEqual(notAcceptable.headers.vary, 'Accept')

  const allZero = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=1;q=0, ' + MEDIA_TYPE + ';version=2;q=0' }
  })
  t.assert.strictEqual(allZero.statusCode, 406)

  const missing = await fastify.inject({
    method: 'GET',
    url: '/does-not-exist',
    headers: { accept: MEDIA_TYPE + ';version=1' }
  })
  t.assert.strictEqual(missing.statusCode, 404)
})

test('wildcards and multiple media types are supported', async (t) => {
  const { fastify } = build()
  t.after(() => fastify.close())

  const subtypeWildcard = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/*;version=2' }
  })
  t.assert.strictEqual(subtypeWildcard.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(subtypeWildcard.payload), { version: 'v2' })

  // same q for every version: the configured version priority wins
  const fullWildcard = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: '*/*' }
  })
  t.assert.strictEqual(fullWildcard.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(fullWildcard.payload), { version: 'v2' })

  // q is compared before media type specificity: the wildcard match of
  // v2 (q=0.9) beats the exact match of v1 (q=0.5)
  const specific = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: '*/*;q=0.9, ' + MEDIA_TYPE + ';version=1;q=0.5' }
  })
  t.assert.strictEqual(specific.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(specific.payload), { version: 'v2' })
})

test('routes without version options are not affected', async (t) => {
  const { fastify } = build()
  fastify.get('/plain', (req, reply) => reply.send({ plain: true }))
  t.after(() => fastify.close())

  for (const headers of [{}, { accept: MEDIA_TYPE + ';version=2' }, { accept: 'text/html' }]) {
    const res = await fastify.inject({ method: 'GET', url: '/plain', headers })
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(JSON.parse(res.payload), { plain: true })
    t.assert.strictEqual(res.headers.vary, undefined)
  }
})

test('combines with the host constraint', async (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1', versionPriority: ['2', '1'] } })
  fastify.get('/demo', {
    apiVersion: '2',
    mediaType: MEDIA_TYPE,
    constraints: { host: 'api.example.com' }
  }, (req, reply) => reply.send({ version: 'v2', host: true }))
  t.after(() => fastify.close())

  const ok = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=2', host: 'api.example.com' }
  })
  t.assert.strictEqual(ok.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(ok.payload), { version: 'v2', host: true })

  const wrongHost = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=2', host: 'other.example.com' }
  })
  t.assert.strictEqual(wrongHost.statusCode, 404)
})

test('concurrent requests do not leak versions', async (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1', versionPriority: ['2', '1'] } })
  fastify.get('/demo', { apiVersion: '1', mediaType: MEDIA_TYPE }, async (req, reply) => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return { version: 'v1' }
  })
  fastify.get('/demo', { apiVersion: '2', mediaType: MEDIA_TYPE }, async (req, reply) => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return { version: 'v2' }
  })
  t.after(() => fastify.close())

  const [one, two] = await Promise.all([
    fastify.inject({ method: 'GET', url: '/demo', headers: { accept: MEDIA_TYPE + ';version=1' } }),
    fastify.inject({ method: 'GET', url: '/demo', headers: { accept: MEDIA_TYPE + ';version=2' } })
  ])
  t.assert.strictEqual(JSON.parse(one.payload).version, 'v1')
  t.assert.strictEqual(JSON.parse(two.payload).version, 'v2')
})

test('Vary: Accept is merged with an existing Vary header', async (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1' } })
  fastify.get('/demo', { apiVersion: '1', mediaType: MEDIA_TYPE }, (req, reply) => {
    reply.header('Vary', 'Accept-Encoding')
    reply.send({ version: 'v1' })
  })
  t.after(() => fastify.close())

  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=1' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers.vary, 'Accept-Encoding, Accept')
})

test('route options require the strategy to be enabled', (t) => {
  const fastify = Fastify()
  t.assert.throws(
    () => fastify.get('/demo', { apiVersion: '1', mediaType: MEDIA_TYPE }, () => {}),
    /FST_ERR_ROUTE_VERSIONING_NOT_ENABLED/
  )
})

test('apiVersion and mediaType must be provided together', (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1' } })
  t.assert.throws(
    () => fastify.get('/demo', { apiVersion: '1' }, () => {}),
    /FST_ERR_ROUTE_VERSIONING_INVALID_OPTIONS/
  )
  t.assert.throws(
    () => fastify.get('/demo', { mediaType: MEDIA_TYPE }, () => {}),
    /FST_ERR_ROUTE_VERSIONING_INVALID_OPTIONS/
  )
})

test('strategy can be registered manually with addConstraintStrategy', async (t) => {
  const { buildMediaTypeVersionStrategy } = require('..')
  const fastify = Fastify()
  fastify.addConstraintStrategy(buildMediaTypeVersionStrategy({ defaultVersion: '1', versionPriority: ['2', '1'] }))
  fastify.get('/demo', { apiVersion: '2', mediaType: MEDIA_TYPE }, (req, reply) => reply.send({ version: 'v2' }))
  t.after(() => fastify.close())

  const res = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: MEDIA_TYPE + ';version=2' }
  })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(JSON.parse(res.payload), { version: 'v2' })
})

test('parseAcceptHeader handles multiple entries and quoted commas', (t) => {
  const entries = parseAcceptHeader(MEDIA_TYPE + ';version="1";q=0.8, text/html;note="x,y", */*;q=0.1')
  t.assert.strictEqual(entries.length, 3)
  t.assert.strictEqual(entries[0].version, '1')
  t.assert.strictEqual(entries[0].q, 0.8)
  t.assert.strictEqual(entries[1].type, 'text')
  t.assert.strictEqual(entries[2].type, '*')
  t.assert.strictEqual(entries[2].q, 0.1)
})
