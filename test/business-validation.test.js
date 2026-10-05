'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fastify = require('../fastify')

function createBarrier () {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

function startServer (app) {
  return new Promise((resolve, reject) => {
    app.listen({ port: 0 }, err => {
      if (err) return reject(err)
      resolve(app.server.address().port)
    })
  })
}

test('business validation - basic pass/fail via inject', async t => {
  const app = fastify()
  let handlerCalls = 0

  app.post('/test', {
    schema: {
      body: {
        type: 'object',
        properties: { a: { type: 'string' } }
      }
    },
    validators: [
      async (req) => {
        if (req.body.a === 'bad') {
          return { field: 'body.a', message: 'is bad' }
        }
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    handlerCalls++
    return { ok: true }
  })

  const pass = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'good' }
  })
  assert.strictEqual(pass.statusCode, 200)
  assert.deepStrictEqual(JSON.parse(pass.body), { ok: true })
  assert.strictEqual(handlerCalls, 1)

  const fail = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'bad' }
  })
  assert.strictEqual(fail.statusCode, 400)
  const failBody = JSON.parse(fail.body)
  assert.strictEqual(failBody.code, 'FST_ERR_BUSINESS_VALIDATION')
  assert.deepStrictEqual(failBody.validation, [
    { field: 'body.a', message: 'is bad' }
  ])
  assert.strictEqual(handlerCalls, 1)
})

test('business validation - errors in registration order despite reverse completion', async t => {
  const app = fastify()
  let handlerCalls = 0

  app.post('/test', {
    validators: [
      async (req) => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return { field: 'body.a', message: 'err1' }
      },
      async (req) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return { field: 'body.b', message: 'err2' }
      }
    ],
    validationFields: ['body.a', 'body.b']
  }, async (req, reply) => {
    handlerCalls++
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x', b: 'y' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation.map(e => e.field), ['body.a', 'body.b'])
  assert.deepStrictEqual(body.validation.map(e => e.message), ['err1', 'err2'])
  assert.strictEqual(handlerCalls, 0)
})

test('business validation - no original request value leaked', async t => {
  const app = fastify()
  const secret = 'super-secret-value'

  app.post('/test', {
    validators: [
      async (req) => {
        return { field: 'body.a', message: 'is bad' }
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: secret }
  })

  assert.strictEqual(res.statusCode, 400)
  assert.ok(!res.body.includes(secret), 'response must not contain the original request value')
  const body = JSON.parse(res.body)
  for (const err of body.validation) {
    assert.deepStrictEqual(Object.keys(err).sort(), ['field', 'message'])
  }
})

test('business validation - illegal field path diagnosed separately', async t => {
  const app = fastify()

  app.post('/test', {
    validators: [
      async (req) => {
        return { field: 'body.undeclared', message: 'nope' }
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation, [])
  assert.deepStrictEqual(body.diagnostics, [
    { field: 'body.undeclared', reason: 'field path is not declared' }
  ])
})

test('business validation - mixed legal and illegal paths', async t => {
  const app = fastify()

  app.post('/test', {
    validators: [
      async (req) => {
        return [
          { field: 'body.a', message: 'legal' },
          { field: 'body.undeclared', message: 'illegal' }
        ]
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation, [
    { field: 'body.a', message: 'legal' }
  ])
  assert.deepStrictEqual(body.diagnostics, [
    { field: 'body.undeclared', reason: 'field path is not declared' }
  ])
})

test('business validation - validator returning array of errors', async t => {
  const app = fastify()

  app.post('/test', {
    validators: [
      async (req) => {
        return [
          { field: 'body.a', message: 'err1' },
          { field: 'body.b', message: 'err2' }
        ]
      }
    ],
    validationFields: ['body.a', 'body.b']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x', b: 'y' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation, [
    { field: 'body.a', message: 'err1' },
    { field: 'body.b', message: 'err2' }
  ])
})

test('business validation - single function normalized to array', async t => {
  const app = fastify()

  app.post('/test', {
    validators: async (req) => {
      return { field: 'body.a', message: 'err1' }
    },
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation, [
    { field: 'body.a', message: 'err1' }
  ])
})

test('business validation - path alias accepted', async t => {
  const app = fastify()

  app.post('/test', {
    validators: [
      async (req) => {
        return { path: 'body.a', message: 'err1' }
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body.validation, [
    { field: 'body.a', message: 'err1' }
  ])
})

test('business validation - no validators means no-op', async t => {
  const app = fastify()
  let handlerCalls = 0

  app.post('/test', {
    schema: {
      body: {
        type: 'object',
        properties: { a: { type: 'string' } }
      }
    }
  }, async (req, reply) => {
    handlerCalls++
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(handlerCalls, 1)
})

test('business validation - schema failure skips business validators', async t => {
  const app = fastify()
  let validatorCalls = 0

  app.post('/test', {
    schema: {
      body: {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } }
      }
    },
    validators: [
      async (req) => {
        validatorCalls++
        return { field: 'body.a', message: 'err1' }
      }
    ],
    validationFields: ['body.a']
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: {}
  })

  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.strictEqual(body.code, 'FST_ERR_VALIDATION')
  assert.strictEqual(validatorCalls, 0)
})

test('business validation - validator throw propagates as internal error', async t => {
  const app = fastify()

  app.post('/test', {
    validators: [
      async (req) => {
        throw new Error('boom')
      }
    ]
  }, async (req, reply) => {
    return { ok: true }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { a: 'x' }
  })

  assert.strictEqual(res.statusCode, 500)
})

test('business validation - cancellation stops late errors and handler', async t => {
  const app = fastify()
  let handlerCalls = 0
  const b1 = createBarrier()
  const b2 = createBarrier()

  app.post('/test', {
    validators: [
      async (req) => {
        await b1.promise
        return { field: 'body.a', message: 'err1' }
      },
      async (req) => {
        await b2.promise
        return { field: 'body.b', message: 'err2' }
      }
    ],
    validationFields: ['body.a', 'body.b']
  }, async (req, reply) => {
    handlerCalls++
    return { ok: true }
  })

  const port = await startServer(app)

  const req = http.request({
    method: 'POST',
    port,
    path: '/test',
    headers: { 'content-type': 'application/json' }
  }, res => {
    assert.fail('should not receive a response after cancellation')
  })

  req.on('error', () => {})

  req.write(JSON.stringify({ a: 'x', b: 'y' }))
  req.end()

  await new Promise(resolve => req.on('finish', resolve))
  req.destroy()

  await new Promise(resolve => setTimeout(resolve, 200))

  b1.release()
  b2.release()

  await new Promise(resolve => setTimeout(resolve, 200))

  assert.strictEqual(handlerCalls, 0)

  await app.close()
})

test('business validation - cancellation stops late success from entering handler', async t => {
  const app = fastify()
  let handlerCalls = 0
  const b1 = createBarrier()
  const b2 = createBarrier()

  app.post('/test', {
    validators: [
      async (req) => {
        await b1.promise
        return null
      },
      async (req) => {
        await b2.promise
        return null
      }
    ]
  }, async (req, reply) => {
    handlerCalls++
    return { ok: true }
  })

  const port = await startServer(app)

  const req = http.request({
    method: 'POST',
    port,
    path: '/test',
    headers: { 'content-type': 'application/json' }
  }, res => {
    assert.fail('should not receive a response after cancellation')
  })

  req.on('error', () => {})

  req.write(JSON.stringify({ a: 'x', b: 'y' }))
  req.end()

  await new Promise(resolve => req.on('finish', resolve))
  req.destroy()

  await new Promise(resolve => setTimeout(resolve, 200))

  b1.release()
  b2.release()

  await new Promise(resolve => setTimeout(resolve, 200))

  assert.strictEqual(handlerCalls, 0)

  await app.close()
})

test('business validation - invalid validators option throws', async t => {
  const app = fastify()

  assert.throws(() => {
    app.post('/test', {
      validators: 'not-an-array'
    }, async (req, reply) => {
      return { ok: true }
    })
  }, /Business validator for route/)
})

test('business validation - invalid validationFields option throws', async t => {
  const app = fastify()

  assert.throws(() => {
    app.post('/test', {
      validators: [async () => null],
      validationFields: 'not-an-array'
    }, async (req, reply) => {
      return { ok: true }
    })
  }, /validationFields for route/)
})
