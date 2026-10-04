'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const Fastify = require('../fastify')

test('response projection: nested array items with x-sensitive keyword', async (t) => {
  const fastify = Fastify()
  const saved = []

  fastify.get('/users', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  token: { type: 'string', 'x-sensitive': true }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const data = { users: [{ name: 'alice', token: 'secret-alice' }, { name: 'bob', token: 'secret-bob' }] }
    saved.push(data)
    return data
  })

  let onSendPayload = null
  fastify.addHook('onSend', async (request, reply, payload) => {
    onSendPayload = payload
    return payload
  })

  const res = await fastify.inject({ method: 'GET', url: '/users' })
  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body, { users: [{ name: 'alice' }, { name: 'bob' }] })
  assert.ok(!res.body.includes('secret-alice'))
  assert.ok(!res.body.includes('secret-bob'))
  // onSend must not see the original token value
  assert.ok(!onSendPayload.includes('secret-alice'))
  assert.ok(!onSendPayload.includes('secret-bob'))
  // handler's saved object is still intact
  assert.strictEqual(saved[0].users[0].token, 'secret-alice')
  assert.strictEqual(saved[0].users[1].token, 'secret-bob')
})

test('response projection: explicit sensitive path rules', async (t) => {
  const fastify = Fastify()

  fastify.get('/accounts', {
    schema: {
      sensitive: ['users[*].token', 'secret'],
      response: {
        200: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  token: { type: 'string' }
                }
              }
            },
            secret: { type: 'string' }
          }
        }
      }
    }
  }, async () => {
    return { users: [{ name: 'carol', token: 'secret-carol' }], secret: 'top-secret' }
  })

  const res = await fastify.inject({ method: 'GET', url: '/accounts' })
  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body, { users: [{ name: 'carol' }] })
  assert.ok(!res.body.includes('secret-carol'))
  assert.ok(!res.body.includes('top-secret'))
})

test('response projection: replacement value', async (t) => {
  const fastify = Fastify()

  fastify.get('/token', {
    schema: {
      sensitive: [{ path: 'token', replace: '***' }],
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            name: { type: 'string' }
          }
        }
      }
    }
  }, async () => ({ token: 'abc123', name: 'dave' }))

  const res = await fastify.inject({ method: 'GET', url: '/token' })
  assert.strictEqual(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.deepStrictEqual(body, { token: '***', name: 'dave' })
})

test('response projection: shared $ref across status codes', async (t) => {
  const fastify = Fastify()

  fastify.addSchema({
    $id: 'user',
    type: 'object',
    properties: {
      name: { type: 'string' },
      token: { type: 'string', 'x-sensitive': true }
    }
  })

  fastify.get('/users', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            users: { type: 'array', items: { $ref: 'user#' } }
          }
        },
        201: {
          type: 'object',
          properties: {
            user: { $ref: 'user#' }
          }
        }
      }
    }
  }, async (request, reply) => {
    if (request.query.code === '201') {
      reply.code(201)
      return { user: { name: 'erin', token: 'secret-erin' } }
    }
    return { users: [{ name: 'frank', token: 'secret-frank' }] }
  })

  const res200 = await fastify.inject({ method: 'GET', url: '/users' })
  assert.strictEqual(res200.statusCode, 200)
  assert.ok(!res200.body.includes('secret-frank'))
  assert.deepStrictEqual(JSON.parse(res200.body), { users: [{ name: 'frank' }] })

  const res201 = await fastify.inject({ method: 'GET', url: '/users?code=201' })
  assert.strictEqual(res201.statusCode, 201)
  assert.ok(!res201.body.includes('secret-erin'))
  assert.deepStrictEqual(JSON.parse(res201.body), { user: { name: 'erin' } })
})

test('response projection: 201 vs 400 different schemas', async (t) => {
  const fastify = Fastify()

  fastify.get('/items', {
    schema: {
      response: {
        201: {
          type: 'object',
          properties: {
            item: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                token: { type: 'string', 'x-sensitive': true }
              }
            }
          }
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            statusCode: { type: 'number' },
            detail: {
              type: 'object',
              properties: {
                reason: { type: 'string', 'x-sensitive': true }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    if (request.query.fail === '1') {
      reply.code(400)
      return { error: 'Bad Request', message: 'nope', statusCode: 400, detail: { reason: 'secret-reason' } }
    }
    reply.code(201)
    return { item: { id: 'item-1', token: 'secret-token' } }
  })

  const res201 = await fastify.inject({ method: 'GET', url: '/items' })
  assert.strictEqual(res201.statusCode, 201)
  assert.ok(!res201.body.includes('secret-token'))
  assert.deepStrictEqual(JSON.parse(res201.body), { item: { id: 'item-1' } })

  const res400 = await fastify.inject({ method: 'GET', url: '/items?fail=1' })
  assert.strictEqual(res400.statusCode, 400)
  assert.ok(!res400.body.includes('secret-reason'))
  const body400 = JSON.parse(res400.body)
  assert.strictEqual(body400.detail.reason, undefined)
  assert.strictEqual(body400.message, 'nope')
})

test('response projection: thrown error uses 400 schema', async (t) => {
  const fastify = Fastify()

  fastify.get('/boom', {
    schema: {
      response: {
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            statusCode: { type: 'number' },
            token: { type: 'string', 'x-sensitive': true }
          }
        }
      }
    }
  }, async () => {
    const err = new Error('boom')
    err.status = 400
    throw err
  })

  const res = await fastify.inject({ method: 'GET', url: '/boom' })
  assert.strictEqual(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.strictEqual(body.message, 'boom')
  assert.strictEqual(body.token, undefined)
})

test('response projection: circular reference in payload does not loop and redacts', async (t) => {
  const fastify = Fastify()
  const saved = []

  fastify.get('/circular', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string', 'x-sensitive': true },
            name: { type: 'string' }
          }
        }
      }
    }
  }, async () => {
    const data = { name: 'circular', token: 'secret-circular' }
    data.self = data
    saved.push(data)
    return data
  })

  const res = await fastify.inject({ method: 'GET', url: '/circular' })
  // The projection must not loop on the cycle and must redact the sensitive
  // field. The serializer drops the cycle, so the response is a normal 200.
  assert.strictEqual(res.statusCode, 200)
  assert.ok(!res.body.includes('secret-circular'))
  assert.deepStrictEqual(JSON.parse(res.body), { name: 'circular' })
  assert.strictEqual(saved[0].token, 'secret-circular')
})

test('response projection: recursive $ref schema', async (t) => {
  const fastify = Fastify()

  fastify.get('/tree', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            value: { type: 'string', 'x-sensitive': true },
            children: { type: 'array', items: { $ref: '#' } }
          }
        }
      }
    }
  }, async () => ({
    value: 'root-secret',
    children: [{ value: 'child-secret', children: [] }]
  }))

  const res = await fastify.inject({ method: 'GET', url: '/tree' })
  assert.strictEqual(res.statusCode, 200)
  assert.ok(!res.body.includes('root-secret'))
  assert.ok(!res.body.includes('child-secret'))
  assert.deepStrictEqual(JSON.parse(res.body), { children: [{ children: [] }] })
})

test('response projection: oneOf strict mode rejects ambiguous config', async (t) => {
  const fastify = Fastify()

  fastify.get('/ambiguous', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              oneOf: [
                { type: 'object', properties: { token: { type: 'string', 'x-sensitive': true } } },
                { type: 'object', properties: { name: { type: 'string' } } }
              ]
            }
          }
        }
      }
    }
  }, async () => ({ data: { name: 'ok' } }))

  await assert.rejects(fastify.ready(), (err) => {
    return err.code === 'FST_ERR_SCH_PROJECTION_AMBIGUOUS'
  })
})

test('response projection: oneOf union mode over-redacts but never leaks', async (t) => {
  const fastify = Fastify()

  fastify.get('/union', {
    schema: {
      sensitiveStrategy: 'union',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              oneOf: [
                { type: 'object', properties: { name: { type: 'string' }, token: { type: 'string', 'x-sensitive': true } } },
                { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } }
              ]
            }
          }
        }
      }
    }
  }, async () => ({ data: { name: 'ok', token: 'secret', id: 'id-1' } }))

  const res = await fastify.inject({ method: 'GET', url: '/union' })
  assert.strictEqual(res.statusCode, 200)
  assert.ok(!res.body.includes('secret'))
  // fjs serializes oneOf using the first branch (name, token); the projection
  // removes token. name is kept, id is not serialized by fjs.
  assert.deepStrictEqual(JSON.parse(res.body), { data: { name: 'ok' } })
})

test('response projection: allOf merges all branches', async (t) => {
  const fastify = Fastify()

  fastify.get('/allof', {
    schema: {
      response: {
        200: {
          type: 'object',
          allOf: [
            { type: 'object', properties: { token: { type: 'string', 'x-sensitive': true } } },
            { type: 'object', properties: { name: { type: 'string' } } }
          ]
        }
      }
    }
  }, async () => ({ token: 'secret', name: 'ok' }))

  const res = await fastify.inject({ method: 'GET', url: '/allof' })
  assert.strictEqual(res.statusCode, 200)
  assert.ok(!res.body.includes('secret'))
  assert.deepStrictEqual(JSON.parse(res.body), { name: 'ok' })
})

test('response projection: serializer exception does not leak sensitive data', async (t) => {
  const fastify = Fastify()
  const saved = []

  fastify.get('/serr', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string', 'x-sensitive': true },
            name: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const data = { name: 'serr', token: 'secret-serr' }
    saved.push(data)
    reply.serializer(() => { throw new Error('serializer boom') })
    return data
  })

  const res = await fastify.inject({ method: 'GET', url: '/serr' })
  assert.strictEqual(res.statusCode, 500)
  assert.ok(!res.body.includes('secret-serr'))
  assert.strictEqual(saved[0].token, 'secret-serr')
})

test('response projection: 2xx fallback status code', async (t) => {
  const fastify = Fastify()

  fastify.get('/fallback', {
    schema: {
      response: {
        '2xx': {
          type: 'object',
          properties: {
            token: { type: 'string', 'x-sensitive': true },
            name: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    reply.code(204)
    return { token: 'secret', name: 'ok' }
  })

  const res = await fastify.inject({ method: 'GET', url: '/fallback' })
  assert.strictEqual(res.statusCode, 204)
  // 204 has no body, but the projection must not throw
  assert.strictEqual(res.body, '')
})

test('response projection: no sensitive fields means no projection overhead', async (t) => {
  const fastify = Fastify()

  fastify.get('/plain', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            name: { type: 'string' }
          }
        }
      }
    }
  }, async () => ({ name: 'ok' }))

  const res = await fastify.inject({ method: 'GET', url: '/plain' })
  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(JSON.parse(res.body), { name: 'ok' })
})
