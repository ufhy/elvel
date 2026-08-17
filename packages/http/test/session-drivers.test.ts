import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection, QueryBuilder, SchemaBuilder } from '@elvel/database'
import { CacheSessionDriver, DatabaseSessionDriver } from '../src/session-drivers.ts'

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('sessions', { driver: 'sqlite', database: ':memory:' })

  await new SchemaBuilder(connection).create('sessions', (table) => {
    table.string('id').primary()
    table.text('payload')
    table.integer('last_activity')
  })
})

const driver = () =>
  new DatabaseSessionDriver(async () => new QueryBuilder(connection, 'sessions') as never)

describe('the database driver', () => {
  test('a session round trips', async () => {
    await driver().write('abc', { name: 'Ada', visits: 2 })

    expect(await driver().read('abc')).toEqual({ name: 'Ada', visits: 2 })
  })

  test('writing twice updates rather than duplicating', async () => {
    await driver().write('abc', { visits: 1 })
    await driver().write('abc', { visits: 2 })

    expect(await driver().read('abc')).toEqual({ visits: 2 })
    expect(await new QueryBuilder(connection, 'sessions').count()).toBe(1)
  })

  test('an unknown id reads as nothing', async () => {
    expect(await driver().read('missing')).toBeUndefined()
  })

  test('the payload is base64, so odd bytes survive the column', async () => {
    await driver().write('abc', { note: 'quotes " and \\ and 笔记 🎉' })

    const row = await new QueryBuilder(connection, 'sessions').where('id', 'abc').first()

    expect(String(row?.payload)).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(await driver().read('abc')).toEqual({ note: 'quotes " and \\ and 笔记 🎉' })
  })

  test('a corrupt payload is a lost session, not a crash', async () => {
    await new QueryBuilder(connection, 'sessions').insert({
      id: 'broken',
      payload: 'not base64 json',
      last_activity: Math.floor(Date.now() / 1000)
    })

    expect(await driver().read('broken')).toBeUndefined()
  })

  test('destroy removes it', async () => {
    await driver().write('abc', { a: 1 })
    await driver().destroy('abc')

    expect(await driver().read('abc')).toBeUndefined()
  })

  test('gc sweeps by last activity, and leaves the fresh alone', async () => {
    await driver().write('fresh', { a: 1 })

    await new QueryBuilder(connection, 'sessions').insert({
      id: 'stale',
      payload: Buffer.from('{}').toString('base64'),
      last_activity: Math.floor(Date.now() / 1000) - 10_000
    })

    expect(await driver().gc(3600)).toBe(1)
    expect(await driver().read('fresh')).toEqual({ a: 1 })
    expect(await driver().read('stale')).toBeUndefined()
  })

  test('two writers racing for one new id end with one row', async () => {
    // The loser of the insert hits the primary key; updating instead is the
    // recovery, and the row existing is all either caller wanted.
    await Promise.all([
      driver().write('same', { from: 'a' }),
      driver().write('same', { from: 'b' })
    ])

    expect(await new QueryBuilder(connection, 'sessions').count()).toBe(1)
  })
})

describe('the cache driver', () => {
  function fakeCache() {
    const store = new Map<string, { value: unknown; seconds?: number }>()

    return {
      store,
      get: async <T>(key: string) => (store.get(key)?.value as T) ?? null,
      put: async (key: string, value: unknown, seconds?: number) => {
        store.set(key, { value, seconds })

        return true
      },
      forget: async (key: string) => store.delete(key)
    }
  }

  test('a session round trips under a prefixed key', async () => {
    const cache = fakeCache()
    const sessions = new CacheSessionDriver(cache, 900)

    await sessions.write('abc', { name: 'Ada' })

    expect(await sessions.read('abc')).toEqual({ name: 'Ada' })
    expect(cache.store.has('session:abc')).toBe(true)
  })

  test('every write pushes the expiry out, which is what keeps a session alive', async () => {
    const cache = fakeCache()

    await new CacheSessionDriver(cache, 900).write('abc', { a: 1 })

    expect(cache.store.get('session:abc')?.seconds).toBe(900)
  })

  test('gc does nothing and says so', async () => {
    // The store expires its own keys; pretending to have swept would be a lie.
    expect(await new CacheSessionDriver(fakeCache()).gc(3600)).toBe(0)
  })

  test('destroy forgets the key', async () => {
    const cache = fakeCache()
    const sessions = new CacheSessionDriver(cache)

    await sessions.write('abc', { a: 1 })
    await sessions.destroy('abc')

    expect(await sessions.read('abc')).toBeUndefined()
  })
})
