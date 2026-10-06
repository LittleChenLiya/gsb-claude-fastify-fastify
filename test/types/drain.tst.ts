import { expect } from 'tstyche'
import fastify, {
  DrainHandle,
  DrainMaintenance,
  DrainStateSnapshot,
  DrainWaitOptions,
  FastifyInstance
} from '../../fastify.js'

const server = fastify()

// route-level group membership
server.get('/a', { drainGroup: 'A' }, async () => ({ ok: true }))
server.route({
  method: 'GET',
  url: '/b',
  drainGroup: 'B',
  handler: async () => ({ ok: true })
})

// plugin-level group membership (inherited down the encapsulation tree)
server.register(async () => {}, { drainGroup: 'G', prefix: '/g' })

// drain API surface
const maintenance: DrainMaintenance = {
  statusCode: 503,
  payload: { maintenance: true },
  headers: { 'x-maintenance': 'yes' }
}

const handle = server.beginDrain('A')
expect(handle).type.toBe<DrainHandle>()
expect(handle.generation).type.toBe<number>()
expect(handle.state).type.toBe<'available' | 'draining' | 'drained'>()
expect(handle.active).type.toBe<number>()
expect(handle.wait()).type.toBe<Promise<DrainStateSnapshot>>()
expect(handle.wait({ signal: new AbortController().signal })).type.toBe<Promise<DrainStateSnapshot>>()

expect(server.beginDrain('A', maintenance)).type.toBe<DrainHandle>()
expect(server.beginDrain('A', { payload: 'down' })).type.toBe<DrainHandle>()

const waitOptions: DrainWaitOptions = { signal: new AbortController().signal }
expect(server.waitForDrain('A')).type.toBe<Promise<DrainStateSnapshot>>()
expect(server.waitForDrain('A', waitOptions)).type.toBe<Promise<DrainStateSnapshot>>()

expect(server.resume('A')).type.toBe<DrainStateSnapshot>()
expect(server.drainState('A')).type.toBe<DrainStateSnapshot>()

const snapshot = server.drainState('A')
expect(snapshot.group).type.toBe<string>()
expect(snapshot.generation).type.toBe<number>()
expect(snapshot.state).type.toBe<'available' | 'draining' | 'drained'>()
expect(snapshot.active).type.toBe<number>()

// methods are available on encapsulated instances too
server.register(async (child) => {
  expect(child.beginDrain('A')).type.toBe<DrainHandle>()
  expect(child.waitForDrain('A')).type.toBe<Promise<DrainStateSnapshot>>()
  expect(child.resume('A')).type.toBe<DrainStateSnapshot>()
  expect(child.drainState('A')).type.toBe<DrainStateSnapshot>()
})

// invalid usages
expect(server.beginDrain).type.not.toBeCallableWith()
expect(server.beginDrain).type.not.toBeCallableWith(42)
expect(server.waitForDrain).type.not.toBeCallableWith()
expect(server.resume).type.not.toBeCallableWith()
expect(server.drainState).type.not.toBeCallableWith()
