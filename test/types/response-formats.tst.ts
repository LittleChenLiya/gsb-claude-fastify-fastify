import { expect } from 'tstyche'
import fastify, { NegotiatedResponseFormat, ResponseFormatDeclaration, ResponseFormatsOption } from '../../fastify.js'

const app = fastify()

// formats as an object map of media type to serializer
app.get('/map', {
  formats: {
    'application/json': (payload) => JSON.stringify(payload),
    'text/plain': (payload) => String(payload)
  }
}, async () => ({ hello: 'world' }))

// formats as an ordered array of declarations
app.get('/array', {
  formats: [
    { contentType: 'application/json', serializer: (payload) => JSON.stringify(payload) },
    { contentType: 'text/plain', serializer: (payload) => String(payload) }
  ]
}, async () => ({ hello: 'world' }))

// the negotiated format is exposed on the request
app.get('/negotiated', {
  formats: {
    'application/json': (payload) => JSON.stringify(payload)
  }
}, async (request) => {
  expect(request.negotiatedFormat).type.toBe<NegotiatedResponseFormat | null>()
  return { hello: 'world' }
})

// exported helper types
expect({
  contentType: 'application/json',
  serializer: (payload: unknown) => JSON.stringify(payload)
}).type.toBeAssignableTo<ResponseFormatDeclaration>()
expect({
  'application/json': (payload: unknown) => JSON.stringify(payload)
}).type.toBeAssignableTo<ResponseFormatsOption>()
