'use strict'

const { test } = require('node:test')
const Fastify = require('..')
const { mediaTypeVersioningPlugin } = Fastify

function buildVersionedApp (options, routeOpts) {
  const fastify = Fastify({
    mediaTypeVersioning: { defaultVersion: '1', versionPriority: ['2', '1'], ...options }
  })
  const calls = { v1: 0, v2: 0 }
  fastify.get('/demo', {
    constraints: { apiVersion: '1', mediaType: 'application/vnd.demo+json' },
    ...routeOpts
  }, (req, reply) => {
    calls.v1++
    reply.send({ version: '1' })
  })
  fastify.get('/demo', {
    constraints: { apiVersion: '2', mediaType: 'application/vnd.demo+json' },
    ...routeOpts
  }, (req, reply) => {
    calls.v2++
    reply.send({ version: '2' })
  })
  return { fastify, calls }
}

test('negotiation selects by q, then priority, and excludes q=0', async (t) => {
  const { fastify, calls } = buildVersionedApp()

  const cases = [
    {
      name: 'higher q wins (v1)',
      accept: 'application/vnd.demo+json;version=1;q=0.9, application/vnd.demo+json;version=2;q=0.4',
      expectedVersion: '1'
    },
    {
      name: 'equal q falls back to configured version priority (v2)',
      accept: 'application/vnd.demo+json;version=1, application/vnd.demo+json;version=2',
      expectedVersion: '2'
    },
    {
      name: 'q=0 excludes a version (v2 excluded)',
      accept: 'application/vnd.demo+json;version=2;q=0, application/vnd.demo+json;version=1;q=0.5',
      expectedVersion: '1'
    }
  ]

  for (const testCase of cases) {
    const before = { ...calls }
    const response = await fastify.inject({
      method: 'GET',
      url: '/demo',
      headers: { accept: testCase.accept }
    })
    const version = response.statusCode === 200 ? response.json().version : null
    t.diagnostic('request accept: ' + testCase.accept)
    t.diagnostic('status: ' + response.statusCode + ', selected version: ' + version)
    t.assert.strictEqual(response.statusCode, 200, testCase.name)
    t.assert.strictEqual(version, testCase.expectedVersion, testCase.name)
    t.assert.strictEqual(calls.v1 + calls.v2, before.v1 + before.v2 + 1, 'exactly one handler executed')
    t.assert.ok(String(response.headers.vary).includes('Accept'), 'Vary: Accept is set')
  }
})

test('q=0 for every matching version returns 406', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version=1;q=0, application/vnd.demo+json;version=2;q=0' }
  })
  t.assert.strictEqual(response.statusCode, 406)
  t.assert.strictEqual(response.json().code, 'FST_ERR_NOT_ACCEPTABLE')
  t.assert.ok(String(response.headers.vary).includes('Accept'))
  t.assert.strictEqual(calls.v1 + calls.v2, 0, 'no handler executed')
})

test('no acceptable version returns 406', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version=3' }
  })
  t.assert.strictEqual(response.statusCode, 406)
  t.assert.strictEqual(calls.v1 + calls.v2, 0, 'no handler executed')
})

test('unknown path still returns 404', async (t) => {
  const { fastify } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/does-not-exist',
    headers: { accept: 'application/vnd.demo+json;version=1' }
  })
  t.assert.strictEqual(response.statusCode, 404)
})

test('comma inside a quoted parameter value does not split entries', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version="2";note="a,b"' }
  })
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.json().version, '2')
  t.assert.strictEqual(calls.v2, 1)
  t.assert.strictEqual(calls.v1, 0)
})

test('duplicate version parameter returns 400', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version=1;version=2' }
  })
  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(response.json().code, 'FST_ERR_ACCEPT_DUPLICATE_VERSION')
  t.assert.strictEqual(calls.v1 + calls.v2, 0, 'no handler executed')
})

test('invalid q value returns 400', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  for (const accept of ['application/vnd.demo+json;version=1;q=1.5', 'application/vnd.demo+json;version=1;q=abc']) {
    const response = await fastify.inject({ method: 'GET', url: '/demo', headers: { accept } })
    t.assert.strictEqual(response.statusCode, 400, accept)
    t.assert.strictEqual(response.json().code, 'FST_ERR_ACCEPT_INVALID_Q', accept)
  }
  t.assert.strictEqual(calls.v1 + calls.v2, 0, 'no handler executed')
})

test('missing Accept header uses the configured default version', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const response = await fastify.inject({ method: 'GET', url: '/demo' })
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.json().version, '1')
  t.assert.strictEqual(calls.v1, 1)
  t.assert.strictEqual(calls.v2, 0)
})

test('wildcards match media types', async (t) => {
  const { fastify } = buildVersionedApp()

  const subtypeWildcard = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/*;version=2' }
  })
  t.assert.strictEqual(subtypeWildcard.statusCode, 200)
  t.assert.strictEqual(subtypeWildcard.json().version, '2')

  const fullWildcard = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: '*/*;version=1' }
  })
  t.assert.strictEqual(fullWildcard.statusCode, 200)
  t.assert.strictEqual(fullWildcard.json().version, '1')
})

test('more specific media type wins over wildcard at equal q', async (t) => {
  const { fastify } = buildVersionedApp()
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/*;version=2;q=0.5, application/vnd.demo+json;version=1;q=0.5' }
  })
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.json().version, '1')
})

test('combines with host constraint', async (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1', versionPriority: ['2', '1'] } })
  fastify.get('/host', { constraints: { apiVersion: '2', mediaType: 'application/vnd.demo+json', host: 'example.com' } }, (req, reply) => {
    reply.send({ version: '2', host: true })
  })

  const matched = await fastify.inject({
    method: 'GET',
    url: '/host',
    headers: { accept: 'application/vnd.demo+json;version=2', host: 'example.com' }
  })
  t.assert.strictEqual(matched.statusCode, 200)
  t.assert.strictEqual(matched.json().version, '2')

  // version negotiation matched, but the host constraint excluded the route
  const wrongHost = await fastify.inject({
    method: 'GET',
    url: '/host',
    headers: { accept: 'application/vnd.demo+json;version=2', host: 'other.example.com' }
  })
  t.assert.strictEqual(wrongHost.statusCode, 404)
})

test('concurrent requests do not leak versions', async (t) => {
  const { fastify, calls } = buildVersionedApp()
  const [resV1, resV2] = await Promise.all([
    fastify.inject({ method: 'GET', url: '/demo', headers: { accept: 'application/vnd.demo+json;version=1' } }),
    fastify.inject({ method: 'GET', url: '/demo', headers: { accept: 'application/vnd.demo+json;version=2' } })
  ])
  t.assert.strictEqual(resV1.json().version, '1')
  t.assert.strictEqual(resV2.json().version, '2')
  t.assert.strictEqual(calls.v1, 1)
  t.assert.strictEqual(calls.v2, 1)
})

test('existing Vary header is preserved and Accept is merged', async (t) => {
  const fastify = Fastify({ mediaTypeVersioning: { defaultVersion: '1' } })
  fastify.get('/vary', { constraints: { apiVersion: '1', mediaType: 'application/vnd.demo+json' } }, (req, reply) => {
    reply.header('Vary', 'X-Custom')
    reply.send({ version: '1' })
  })
  const response = await fastify.inject({
    method: 'GET',
    url: '/vary',
    headers: { accept: 'application/vnd.demo+json;version=1' }
  })
  t.assert.strictEqual(response.statusCode, 200)
  const vary = response.headers.vary
  const tokens = (Array.isArray(vary) ? vary.join(',') : String(vary)).split(',').map(token => token.trim().toLowerCase())
  t.assert.ok(tokens.includes('x-custom'), 'original Vary value is preserved')
  t.assert.ok(tokens.includes('accept'), 'Accept is merged into Vary')
})

test('routes without version constraints are not affected', async (t) => {
  const { fastify } = buildVersionedApp()
  fastify.get('/plain', (req, reply) => reply.send({ plain: true }))

  const noAccept = await fastify.inject({ method: 'GET', url: '/plain' })
  t.assert.strictEqual(noAccept.statusCode, 200)
  t.assert.strictEqual(noAccept.headers.vary, undefined)

  const withAccept = await fastify.inject({
    method: 'GET',
    url: '/plain',
    headers: { accept: 'application/vnd.demo+json;version=2;q=0.8' }
  })
  t.assert.strictEqual(withAccept.statusCode, 200)
  t.assert.deepStrictEqual(withAccept.json(), { plain: true })
})

test('unversioned route on the same path still matches', async (t) => {
  const { fastify } = buildVersionedApp()
  fastify.get('/demo', (req, reply) => reply.send({ version: 'unversioned' }))
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version=3' }
  })
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.json().version, 'unversioned')
})

test('can be enabled as a plugin', async (t) => {
  const fastify = Fastify()
  fastify.register(mediaTypeVersioningPlugin, { defaultVersion: '1', versionPriority: ['2', '1'] })
  // routes must be registered after the plugin has been loaded
  fastify.register((instance, opts, done) => {
    instance.get('/demo', { constraints: { apiVersion: '1', mediaType: 'application/vnd.demo+json' } }, (req, reply) => {
      reply.send({ version: '1' })
    })
    instance.get('/demo', { constraints: { apiVersion: '2', mediaType: 'application/vnd.demo+json' } }, (req, reply) => {
      reply.send({ version: '2' })
    })
    done()
  })
  const response = await fastify.inject({
    method: 'GET',
    url: '/demo',
    headers: { accept: 'application/vnd.demo+json;version=2' }
  })
  t.assert.strictEqual(response.statusCode, 200)
  t.assert.strictEqual(response.json().version, '2')
})

test('registering versioned routes without enabling the strategy throws', async (t) => {
  const fastify = Fastify()
  t.assert.throws(
    () => fastify.get('/demo', { constraints: { apiVersion: '1', mediaType: 'application/vnd.demo+json' } }, () => {}),
    /FST_ERR_VERSIONING_NOT_ENABLED/
  )
})

test('invalid strategy options throw', async (t) => {
  // invalid option shapes are rejected by the initial config validation
  t.assert.throws(() => Fastify({ mediaTypeVersioning: { defaultVersion: 1 } }), /FST_ERR_VERSIONING_INVALID_OPTIONS/)
  t.assert.throws(() => Fastify({ mediaTypeVersioning: { versionPriority: '2' } }), /FST_ERR_INIT_OPTS_INVALID/)
  // the plugin path validates the options itself
  const fastify = Fastify()
  fastify.register(mediaTypeVersioningPlugin, { defaultVersion: 1 })
  await t.assert.rejects(fastify.ready(), /FST_ERR_VERSIONING_INVALID_OPTIONS/)
})

test('hasRoute and findRoute work with apiVersion and mediaType constraints', async (t) => {
  const { fastify } = buildVersionedApp()
  t.assert.strictEqual(fastify.hasRoute({
    method: 'GET',
    url: '/demo',
    constraints: { apiVersion: '1', mediaType: 'application/vnd.demo+json' }
  }), true)
  t.assert.strictEqual(fastify.hasRoute({
    method: 'GET',
    url: '/demo',
    constraints: { apiVersion: '3', mediaType: 'application/vnd.demo+json' }
  }), false)
  const found = fastify.findRoute({
    method: 'GET',
    url: '/demo',
    constraints: { apiVersion: '2', mediaType: 'application/vnd.demo+json' }
  })
  t.assert.ok(found !== null)
  t.assert.strictEqual(typeof found.handler, 'function')
})
