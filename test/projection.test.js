'use strict'

const { test } = require('node:test')
const Fastify = require('..')

const userSchema = {
  $id: 'user',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    token: { type: 'string' }
  }
}

test('projection removes users[*].token: client and onSend never see it, handler object untouched', (t, testDone) => {
  t.plan(6)
  const fastify = Fastify()
  fastify.addSchema(userSchema)

  let saved
  fastify.get('/users', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            users: { type: 'array', items: { $ref: 'user#' } }
          }
        }
      }
    },
    projection: { paths: ['users[*].token'] }
  }, (req, reply) => {
    saved = {
      users: [
        { id: 1, name: 'alice', token: 'secret-1' },
        { id: 2, name: 'bob', token: 'secret-2' }
      ]
    }
    reply.send(saved)
  })

  fastify.addHook('onSend', (req, reply, payload, done) => {
    t.assert.strictEqual(payload.includes('secret'), false, 'onSend must not see the token')
    done()
  })

  fastify.inject('/users', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), {
      users: [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' }
      ]
    })
    t.assert.strictEqual(res.payload.includes('secret'), false, 'client must not see the token')
    t.assert.deepStrictEqual(saved, {
      users: [
        { id: 1, name: 'alice', token: 'secret-1' },
        { id: 2, name: 'bob', token: 'secret-2' }
      ]
    }, 'handler object must keep the token')
    testDone()
  })
})

test('projection without response schema still redacts (defense in depth)', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.get('/no-schema', {
    projection: { paths: ['credentials.password'] }
  }, (req, reply) => {
    reply.send({ credentials: { username: 'u', password: 'p' } })
  })

  fastify.inject('/no-schema', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { credentials: { username: 'u' } })
    t.assert.strictEqual(res.payload.includes('password'), false)
    testDone()
  })
})

test('projection replace action substitutes the sensitive value', (t, testDone) => {
  t.plan(2)
  const fastify = Fastify()

  fastify.get('/replace', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            meta: {
              type: 'object',
              properties: {
                secret: { type: 'string' },
                note: { type: 'string' }
              }
            }
          }
        }
      }
    },
    projection: {
      paths: [{ path: 'meta.secret', action: 'replace', replacement: '***' }]
    }
  }, (req, reply) => {
    reply.send({ meta: { secret: 's3cr3t', note: 'visible' } })
  })

  fastify.inject('/replace', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { meta: { secret: '***', note: 'visible' } })
    testDone()
  })
})

test('projection with global replace default replacement', (t, testDone) => {
  t.plan(2)
  const fastify = Fastify()

  fastify.get('/replace-default', {
    projection: { paths: ['token'], action: 'replace' }
  }, (req, reply) => {
    reply.send({ token: 'abc', id: 1 })
  })

  fastify.inject('/replace-default', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { token: '[REDACTED]', id: 1 })
    testDone()
  })
})

test('projection resolves shared $ref schemas (nested objects and arrays)', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()
  fastify.addSchema(userSchema)

  fastify.get('/nested', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            owner: { $ref: 'user#' },
            users: { type: 'array', items: { $ref: 'user#' } }
          }
        }
      }
    },
    projection: { paths: ['owner.token', 'users[*].token'] }
  }, (req, reply) => {
    reply.send({
      owner: { id: 1, name: 'root', token: 'root-secret' },
      users: [{ id: 2, name: 'a', token: 'a-secret' }]
    })
  })

  fastify.inject('/nested', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), {
      owner: { id: 1, name: 'root' },
      users: [{ id: 2, name: 'a' }]
    })
    t.assert.strictEqual(res.payload.includes('secret'), false)
    testDone()
  })
})

test('projection selects the schema of the response status code (201 vs 400)', (t, testDone) => {
  t.plan(5)
  const fastify = Fastify()

  fastify.post('/users', {
    schema: {
      body: {
        type: 'object',
        properties: { name: { type: 'string' } }
      },
      response: {
        201: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                token: { type: 'string' }
              }
            }
          }
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            debug: {
              type: 'object',
              properties: {
                secret: { type: 'string' },
                detail: { type: 'string' }
              }
            }
          }
        }
      }
    },
    projection: { paths: ['user.token', 'debug.secret'] }
  }, (req, reply) => {
    if (!req.body || typeof req.body.name !== 'string') {
      reply.code(400).send({ error: 'bad request', debug: { secret: 'internal-token', detail: 'name required' } })
      return
    }
    reply.code(201).send({ user: { name: req.body.name, token: 'fresh-token' } })
  })

  fastify.inject({ method: 'POST', url: '/users', payload: { name: 'alice' } }, (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 201)
    t.assert.deepStrictEqual(res.json(), { user: { name: 'alice' } })

    fastify.inject({ method: 'POST', url: '/users', payload: {} }, (err2, res2) => {
      t.assert.ifError(err2)
      t.assert.deepStrictEqual(res2.json(), { error: 'bad request', debug: { detail: 'name required' } })
      testDone()
    })
  })
})

test('projection applies to error responses from a custom error handler', (t, testDone) => {
  t.plan(4)
  const fastify = Fastify()

  fastify.setErrorHandler((error, request, reply) => {
    reply.code(500).send({ message: error.message, internal: { token: 'server-secret' } })
  })

  fastify.get('/boom', {
    schema: {
      response: {
        500: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            internal: {
              type: 'object',
              properties: {
                token: { type: 'string' }
              }
            }
          }
        }
      }
    },
    projection: { paths: ['internal.token'] }
  }, (req, reply) => {
    throw new Error('kaboom')
  })

  fastify.inject('/boom', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.deepStrictEqual(res.json(), { message: 'kaboom', internal: {} })
    t.assert.strictEqual(res.payload.includes('server-secret'), false)
    testDone()
  })
})

test('projection leaves the default error response untouched', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.get('/default-error', {
    projection: { paths: ['users[*].token'] }
  }, (req, reply) => {
    throw new Error('kaboom')
  })

  fastify.inject('/default-error', (err, res) => {
    t.assert.ifError(err)
    t.assert.strictEqual(res.statusCode, 500)
    const body = res.json()
    t.assert.strictEqual(body.message, 'kaboom')
    testDone()
  })
})

test('projection handles circular $ref schemas without hanging', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()
  fastify.addSchema({
    $id: 'node',
    type: 'object',
    properties: {
      value: { type: 'string' },
      token: { type: 'string' },
      child: { $ref: 'node#' }
    }
  })

  fastify.get('/tree', {
    schema: {
      response: {
        200: { $ref: 'node#' }
      }
    },
    projection: { paths: ['token', 'child.token'] }
  }, (req, reply) => {
    reply.send({
      value: 'root',
      token: 'root-secret',
      child: { value: 'leaf', token: 'leaf-secret' }
    })
  })

  fastify.inject('/tree', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), {
      value: 'root',
      child: { value: 'leaf' }
    })
    t.assert.strictEqual(res.payload.includes('secret'), false)
    testDone()
  })
})

test('projection rejects ambiguous oneOf branches by default', (t, testDone) => {
  t.plan(2)
  const fastify = Fastify()

  fastify.get('/ambiguous', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            payload: {
              oneOf: [
                { type: 'object', properties: { token: { type: 'string' } } },
                { type: 'object', properties: { other: { type: 'string' } } }
              ]
            }
          }
        }
      }
    },
    projection: { paths: ['payload.token'] }
  }, (req, reply) => {
    reply.send({ payload: { token: 'x' } })
  })

  fastify.ready((err) => {
    t.assert.strictEqual(err.code, 'FST_ERR_PROJECTION_AMBIGUOUS')
    t.assert.match(err.message, /payload\.token/)
    testDone()
  })
})

test('projection redact-subtree strategy redacts the whole ambiguous subtree', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.get('/ambiguous-subtree', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            payload: {
              oneOf: [
                { type: 'object', properties: { token: { type: 'string' } } },
                { type: 'object', properties: { other: { type: 'string' } } }
              ]
            }
          }
        }
      }
    },
    projection: {
      paths: ['payload.token'],
      onAmbiguous: 'redact-subtree'
    }
  }, (req, reply) => {
    reply.send({ id: 1, payload: { token: 'never-guess' } })
  })

  fastify.inject('/ambiguous-subtree', (err, res) => {
    t.assert.ifError(err)
    t.assert.deepStrictEqual(res.json(), { id: 1 })
    t.assert.strictEqual(res.payload.includes('never-guess'), false)
    testDone()
  })
})

test('projection surfaces serializer exceptions as 500 without leaking', (t, testDone) => {
  t.plan(5)
  const fastify = Fastify()

  fastify.get('/broken-serializer', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            token: { type: 'string' }
          }
        }
      }
    },
    serializerCompiler: () => () => { throw new Error('serialize boom') },
    projection: { paths: ['token'] }
  }, (req, reply) => {
    reply.send({ name: 'loop', token: 'secret' })
  })

  fastify.get('/fine', {
    projection: { paths: ['token'] }
  }, (req, reply) => {
    reply.send({ name: 'ok', token: 'secret' })
  })

  fastify.inject('/broken-serializer', (err, res) => {
    t.assert.ifError(err)
    // The serialization error must surface as a 500 and the token must not leak.
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(res.payload.includes('secret'), false)

    // The server must still be responsive afterwards.
    fastify.inject('/fine', (err2, res2) => {
      t.assert.ifError(err2)
      t.assert.deepStrictEqual(res2.json(), { name: 'ok' })
      testDone()
    })
  })
})

test('projection tolerates circular payload structures without hanging', (t, testDone) => {
  t.plan(3)
  const fastify = Fastify()

  fastify.get('/circular', {
    projection: { paths: ['token', 'child.token'] }
  }, (req, reply) => {
    const payload = { name: 'loop', token: 'secret' }
    payload.child = payload
    reply.send(payload)
  })

  fastify.inject('/circular', (err, res) => {
    t.assert.ifError(err)
    // The projection itself must not loop on the circular structure; the
    // default JSON.stringify serializer then fails on it and the error
    // surfaces as a 500 without leaking the token.
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.strictEqual(res.payload.includes('secret'), false)
    testDone()
  })
})

test('projection invalid configuration throws at route registration', (t, testDone) => {
  t.plan(6)
  const fastify = Fastify()

  t.assert.throws(() => {
    fastify.get('/a', { projection: 'nope' }, () => {})
  }, /Invalid response projection configuration/)

  t.assert.throws(() => {
    fastify.get('/b', { projection: { paths: [] } }, () => {})
  }, /Invalid response projection configuration/)

  t.assert.throws(() => {
    fastify.get('/c', { projection: { paths: ['a.b'], action: 'drop' } }, () => {})
  }, /Invalid response projection configuration/)

  t.assert.throws(() => {
    fastify.get('/d', { projection: { paths: ['a.b'], onAmbiguous: 'guess' } }, () => {})
  }, /Invalid response projection configuration/)

  t.assert.throws(() => {
    fastify.get('/e', { projection: { paths: [''] } }, () => {})
  }, /Invalid response projection configuration/)

  try {
    fastify.get('/f', { projection: { paths: ['a.b'] } }, () => {})
    t.assert.ok(true)
  } catch {
    t.assert.fail('valid projection must not throw')
  }
  testDone()
})

test('projection does not mutate payloads without sensitive fields (same reference)', (t, testDone) => {
  t.plan(3)

  const { applyProjection, compileProjection, normalizeProjectionConfig, selectProjectionTree } = require('../lib/projection')
  const config = normalizeProjectionConfig({ paths: ['users[*].token'] })
  const compiled = compileProjection(config, undefined, {})
  const tree = selectProjectionTree(compiled, 200)

  const untouched = { users: [{ id: 1 }] }
  t.assert.strictEqual(applyProjection(untouched, tree), untouched, 'no sensitive field: same reference')

  const withToken = { users: [{ id: 1, token: 'x' }] }
  const projected = applyProjection(withToken, tree)
  t.assert.deepStrictEqual(projected, { users: [{ id: 1 }] })
  t.assert.deepStrictEqual(withToken, { users: [{ id: 1, token: 'x' }] }, 'input not mutated')
  testDone()
})
