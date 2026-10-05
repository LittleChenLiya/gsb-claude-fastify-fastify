'use strict'

const { test } = require('node:test')
const http = require('node:http')
const Fastify = require('..')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bodySchema = {
  body: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      token: { type: 'string' }
    },
    required: ['email']
  }
}

function captureErrors (fastify, captured) {
  fastify.setErrorHandler((err, req, reply) => {
    captured.push(err)
    reply.status(err.statusCode || 500).send({
      code: err.code,
      message: err.message,
      validation: err.validation,
      diagnostics: err.diagnostics
    })
  })
}

test('boot: invalid asyncValidators declarations are rejected at registration', async (t) => {
  t.plan(5)

  const fastify = Fastify()

  t.assert.throws(() => {
    fastify.post('/a', { asyncValidators: 'nope', handler: () => ({}) })
  }, /FST_ERR_ASYNC_VALIDATORS_INVALID/)

  t.assert.throws(() => {
    fastify.post('/b', { asyncValidators: [{ path: 'body.x' }], handler: () => ({}) })
  }, /FST_ERR_ASYNC_VALIDATORS_INVALID/)

  t.assert.throws(() => {
    fastify.post('/c', { asyncValidators: [{ path: 'server.x', validate: async () => {} }], handler: () => ({}) })
  }, /FST_ERR_ASYNC_VALIDATORS_INVALID/)

  t.assert.throws(() => {
    fastify.post('/d', { asyncValidators: [{ path: 'body.__proto__.x', validate: async () => {} }], handler: () => ({}) })
  }, /FST_ERR_ASYNC_VALIDATORS_INVALID/)

  t.assert.throws(() => {
    fastify.post('/e', { asyncValidators: [null], handler: () => ({}) })
  }, /FST_ERR_ASYNC_VALIDATORS_INVALID/)
})

test('all validators pass: handler runs, validators receive value, request and instance', async (t) => {
  t.plan(6)

  const fastify = Fastify()
  const seen = []

  fastify.decorate('marker', 'fastify-instance')

  fastify.post('/user', {
    schema: bodySchema,
    asyncValidators: [
      {
        path: 'body.email',
        validate: async function (value, request) {
          seen.push(['email', value, request.body.token, this.marker])
          return null
        }
      },
      {
        path: 'query.trace',
        validate: async (value) => {
          seen.push(['trace', value])
          return null
        }
      }
    ],
    handler: async (request) => ({ ok: true })
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/user?trace=abc',
    payload: { email: 'a@b.c', token: 'secret-token' }
  })

  t.assert.strictEqual(response.statusCode, 200)
  t.assert.deepStrictEqual(response.json(), { ok: true })
  t.assert.strictEqual(seen.length, 2)
  t.assert.deepStrictEqual(seen[0], ['email', 'a@b.c', 'secret-token', 'fastify-instance'])
  t.assert.deepStrictEqual(seen[1], ['trace', 'abc'])
  t.assert.ok(true)
})

test('route without asyncValidators keeps the previous behavior', async (t) => {
  t.plan(3)

  const fastify = Fastify()

  fastify.post('/plain', { schema: bodySchema, handler: async () => ({ ok: true }) })

  const ok = await fastify.inject({ method: 'POST', url: '/plain', payload: { email: 'a@b.c' } })
  t.assert.strictEqual(ok.statusCode, 200)
  t.assert.deepStrictEqual(ok.json(), { ok: true })

  const bad = await fastify.inject({ method: 'POST', url: '/plain', payload: {} })
  t.assert.strictEqual(bad.statusCode, 400)
})

test('schema validation runs first: async validators are skipped on schema failure', async (t) => {
  t.plan(4)

  const fastify = Fastify()
  let validatorCalls = 0
  let handlerCalls = 0

  fastify.post('/user', {
    schema: bodySchema,
    asyncValidators: [
      { path: 'body.email', validate: async () => { validatorCalls++; return null } }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  const response = await fastify.inject({ method: 'POST', url: '/user', payload: {} })

  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(response.json().code, 'FST_ERR_VALIDATION')
  t.assert.strictEqual(validatorCalls, 0)
  t.assert.strictEqual(handlerCalls, 0)
})

test('out-of-order completion: merged errors keep the registration order, handler not called', async (t) => {
  t.plan(6)

  const fastify = Fastify()
  const captured = []
  captureErrors(fastify, captured)

  let handlerCalls = 0
  const settled = []

  fastify.post('/order', {
    schema: bodySchema,
    asyncValidators: [
      {
        // registered first, settles last
        path: 'body.email',
        validate: async () => {
          await sleep(60)
          settled.push('email')
          return { message: 'email is taken', code: 'EMAIL_TAKEN' }
        }
      },
      {
        // registered second, settles first
        path: 'body.token',
        validate: async () => {
          await sleep(5)
          settled.push('token')
          return { message: 'token is revoked', code: 'TOKEN_REVOKED' }
        }
      }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/order',
    payload: { email: 'a@b.c', token: 'tok' }
  })

  // the validators really settled in reverse registration order
  t.assert.deepStrictEqual(settled, ['token', 'email'])
  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(response.statusCode, 400)

  const err = captured[0]
  t.assert.strictEqual(err.code, 'FST_ERR_ASYNC_VALIDATION')
  t.assert.strictEqual(err.validationContext, 'asyncValidators')
  // stable registration order, not settlement order
  t.assert.deepStrictEqual(
    err.validation,
    [
      { path: 'body.email', message: 'email is taken', code: 'EMAIL_TAKEN' },
      { path: 'body.token', message: 'token is revoked', code: 'TOKEN_REVOKED' }
    ]
  )
})

test('barrier: the handler is not entered before every validator settled', async (t) => {
  t.plan(4)

  const fastify = Fastify()
  const events = []

  fastify.post('/barrier', {
    asyncValidators: [
      {
        path: 'body.fast',
        validate: async () => {
          await sleep(5)
          events.push('fast-pass')
          return null
        }
      },
      {
        path: 'body.slow',
        validate: async () => {
          await sleep(50)
          events.push('slow-fail')
          return { message: 'slow check failed' }
        }
      }
    ],
    handler: async () => {
      events.push('handler')
      return { ok: true }
    }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/barrier',
    payload: { fast: 1, slow: 2 }
  })

  t.assert.strictEqual(response.statusCode, 400)
  // the fast validator passed long before the slow one failed, yet the
  // handler was never entered: the layer waits for the whole barrier
  t.assert.deepStrictEqual(events, ['fast-pass', 'slow-fail'])
  t.assert.strictEqual(response.json().code, 'FST_ERR_ASYNC_VALIDATION')
  t.assert.ok(true)
})

test('reported errors never carry original request values', async (t) => {
  t.plan(5)

  const fastify = Fastify()
  const captured = []
  captureErrors(fastify, captured)

  const secret = 'super-secret-value'

  fastify.post('/leak', {
    asyncValidators: [
      {
        path: 'body.password',
        validate: async (value, request) => {
          // a misbehaving validator trying to echo the request payload
          return {
            message: 'password too weak',
            value,
            data: request.body,
            instancePath: '/password'
          }
        }
      }
    ],
    handler: async () => ({ ok: true })
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/leak',
    payload: { password: secret }
  })

  t.assert.strictEqual(response.statusCode, 400)
  const err = captured[0]
  t.assert.strictEqual(err.code, 'FST_ERR_ASYNC_VALIDATION')
  // only path/message/code survive the sanitization
  t.assert.deepStrictEqual(err.validation, [
    { path: 'body.password', message: 'password too weak' }
  ])
  t.assert.strictEqual('value' in err.validation[0], false)
  // the raw response must not leak the original request value either
  t.assert.strictEqual(response.payload.includes(secret), false)
})

test('undeclared path in a returned error is diagnosed separately (500), not merged into the 400 result', async (t) => {
  t.plan(7)

  const fastify = Fastify()
  const captured = []
  captureErrors(fastify, captured)

  let handlerCalls = 0

  fastify.post('/paths', {
    asyncValidators: [
      {
        path: 'body.alpha',
        validate: async () => ({ message: 'alpha is invalid', code: 'BAD_ALPHA' })
      },
      {
        path: 'body.beta',
        validate: async () => {
          await sleep(10)
          // contract violation: reports an error for a path it did not declare
          return { message: 'gamma is invalid', path: 'body.gamma' }
        }
      }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/paths',
    payload: { alpha: 1, beta: 2 }
  })

  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(response.statusCode, 500)

  const err = captured[0]
  t.assert.strictEqual(err.code, 'FST_ERR_ASYNC_VALIDATOR_PATH')
  // the business failure of the first validator is NOT merged into this
  // diagnostic result
  t.assert.strictEqual(err.validation, undefined)
  t.assert.strictEqual(Array.isArray(err.diagnostics), true)
  t.assert.strictEqual(err.diagnostics[0].code, 'FST_ERR_ASYNC_VALIDATOR_PATH')
  t.assert.strictEqual(err.diagnostics[0].path, 'body.beta')
})

test('invalid validator result shape is diagnosed separately (500)', async (t) => {
  t.plan(4)

  const fastify = Fastify()
  const captured = []
  captureErrors(fastify, captured)

  let handlerCalls = 0

  fastify.post('/shape', {
    asyncValidators: [
      { path: 'body.alpha', validate: async () => 'not-a-valid-report' }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/shape',
    payload: { alpha: 1 }
  })

  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.strictEqual(captured[0].code, 'FST_ERR_ASYNC_VALIDATOR_RESULT')
  t.assert.strictEqual(captured[0].diagnostics[0].path, 'body.alpha')
})

test('a thrown validator error surfaces as a 500 and skips the handler', async (t) => {
  t.plan(3)

  const fastify = Fastify()
  let handlerCalls = 0

  fastify.post('/boom', {
    asyncValidators: [
      {
        path: 'body.alpha',
        validate: async () => { throw new Error('database is down') }
      }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/boom',
    payload: { alpha: 1 }
  })

  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(response.statusCode, 500)
  t.assert.strictEqual(response.json().message, 'database is down')
})

test('multiple errors from a single validator are merged in place', async (t) => {
  t.plan(3)

  const fastify = Fastify()
  const captured = []
  captureErrors(fastify, captured)

  fastify.post('/multi', {
    asyncValidators: [
      {
        path: 'body.alpha',
        validate: async () => [
          { message: 'first problem' },
          { message: 'second problem', code: 'SECOND' }
        ]
      }
    ],
    handler: async () => ({ ok: true })
  })

  const response = await fastify.inject({
    method: 'POST',
    url: '/multi',
    payload: { alpha: 1 }
  })

  t.assert.strictEqual(response.statusCode, 400)
  t.assert.strictEqual(captured[0].code, 'FST_ERR_ASYNC_VALIDATION')
  t.assert.deepStrictEqual(captured[0].validation, [
    { path: 'body.alpha', message: 'first problem' },
    { path: 'body.alpha', message: 'second problem', code: 'SECOND' }
  ])
})

test('request cancellation: late validator failure is not published and handler is not entered', async (t) => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let handlerCalls = 0
  let errorHandlerCalls = 0
  let validatorSettled = false

  fastify.setErrorHandler((err, req, reply) => {
    errorHandlerCalls++
    reply.status(err.statusCode || 500).send(err)
  })

  fastify.post('/cancel-failure', {
    asyncValidators: [
      {
        path: 'body.token',
        validate: async () => {
          await sleep(150)
          validatorSettled = true
          // late failure: the request is already cancelled, this error must
          // never be published
          return { message: 'token revoked' }
        }
      }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const { port } = fastify.server.address()

  await new Promise((resolve) => {
    const req = http.request({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/cancel-failure',
      headers: { 'content-type': 'application/json' }
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ token: 'tok' }))
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 30)
  })

  // give the validator time to settle after the cancellation
  await sleep(300)

  t.assert.strictEqual(validatorSettled, true)
  t.assert.strictEqual(handlerCalls, 0)
  t.assert.strictEqual(errorHandlerCalls, 0)
})

test('request cancellation: late validator success does not enter the handler either', async (t) => {
  t.plan(3)

  const fastify = Fastify()
  t.after(() => fastify.close())

  let handlerCalls = 0
  let validatorSettled = false

  fastify.post('/cancel-success', {
    asyncValidators: [
      {
        path: 'body.token',
        validate: async () => {
          await sleep(150)
          validatorSettled = true
          // late success: must not let the request into the handler
          return null
        }
      }
    ],
    handler: async () => { handlerCalls++; return { ok: true } }
  })

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const { port } = fastify.server.address()

  await new Promise((resolve) => {
    const req = http.request({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/cancel-success',
      headers: { 'content-type': 'application/json' }
    })
    req.on('error', () => {})
    req.end(JSON.stringify({ token: 'tok' }))
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 30)
  })

  await sleep(300)

  t.assert.strictEqual(validatorSettled, true)
  t.assert.strictEqual(handlerCalls, 0)
  t.assert.ok(true)
})
