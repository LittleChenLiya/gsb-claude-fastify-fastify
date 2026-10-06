import { expect } from 'tstyche'
import fastify, {
  DrainResponseOptions,
  DrainStateSnapshot,
  FastifyInstance,
  WaitDrainOptions
} from '../../fastify.js'

const app = fastify()

// drain group assignment via register options
app.register(async () => {}, { drainGroup: 'group-a' })
app.register(async () => {}, { prefix: '/x', drainGroup: 'group-b' })

// drain group assignment via route options
app.get('/a', { drainGroup: 'group-a' }, async () => 'a')
app.get('/b', { drainGroup: null }, async () => 'b')

const responseOptions: DrainResponseOptions = {
  statusCode: 503,
  payload: { maintenance: true },
  headers: { 'retry-after': '30' }
}

const begun: DrainStateSnapshot = app.beginDrain('group-a', responseOptions)
expect(app.beginDrain('group-a')).type.toBe<DrainStateSnapshot>()
expect(begun.state).type.toBe<'active' | 'draining' | 'drained'>()
expect(begun.generation).type.toBe<number>()
expect(begun.activeCount).type.toBe<number>()
expect(begun.group).type.toBe<string>()

const waitOptions: WaitDrainOptions = { signal: new AbortController().signal }
expect(app.waitDrain('group-a', waitOptions)).type.toBe<Promise<DrainStateSnapshot>>()
expect(app.waitDrain('group-a')).type.toBe<Promise<DrainStateSnapshot>>()

expect(app.resumeDrain('group-a')).type.toBe<DrainStateSnapshot>()
expect(app.drainState('group-a')).type.toBe<DrainStateSnapshot>()

// the API is also available on encapsulated instances
app.register(async (instance: FastifyInstance) => {
  expect(instance.beginDrain('group-a')).type.toBe<DrainStateSnapshot>()
  expect(instance.waitDrain('group-a')).type.toBe<Promise<DrainStateSnapshot>>()
  expect(instance.resumeDrain('group-a')).type.toBe<DrainStateSnapshot>()
  expect(instance.drainState('group-a')).type.toBe<DrainStateSnapshot>()
}, { drainGroup: 'group-a' })
