import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { reachable } from '../../../tests/support/dialects.ts'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryBuilder } from '../src/query/builder.ts'

/**
 * `claim()` — write a row unless a live one already holds its key.
 *
 * The primitive behind a database lock and behind `Cache::add`. Both were a
 * `delete` of the expired row followed by an `insertOrIgnore`: two round trips to
 * answer one question, 148µs against 92µs on Postgres.
 *
 * Every dialect has to give the same answer from different SQL. Postgres and
 * SQLite carry the condition in `on conflict … do update … where`; MySQL has no
 * `where` there, so each assignment becomes `if(expired, new, old)` and the answer
 * comes from its affected-row count being non-zero. Three shapes, one meaning —
 * which is exactly the sort of thing that is right on the engine it was written
 * against and wrong on the others.
 */
const available = await reachable('claim')

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

const TABLE = 'claim_probe'

for (const { name, config } of available) {
  describe(`claim: ${name}`, () => {
    let connection: BunSqlConnection

    const table = () => new QueryBuilder(connection, TABLE)

    /** Seconds since the epoch, the unit both the cache and the lock store. */
    const now = () => Math.floor(Date.now() / 1000)

    const rows = async () =>
      connection.select<{ holder: string; expiration: number }>(
        `select holder, expiration from ${connection.grammar.wrapTable(TABLE)}`
      )

    beforeEach(async () => {
      connection = await BunSqlConnection.make(name, config as never)

      const key = connection.grammar.wrap('key')
      const holder = connection.grammar.wrap('holder')
      const wrapped = connection.grammar.wrapTable(TABLE)

      await connection.statement(`drop table if exists ${wrapped}`)
      await connection.statement(
        `create table ${wrapped} (${key} varchar(191) primary key, ${holder} varchar(60), expiration integer)`
      )
    })

    afterEach(async () => {
      await connection.statement(`drop table if exists ${connection.grammar.wrapTable(TABLE)}`)
      await connection.disconnect()
    })

    test('an absent key is claimed', async () => {
      const won = await table().claim(
        { key: 'k', holder: 'first', expiration: now() + 60 },
        ['key'],
        'expiration',
        now()
      )

      expect<boolean>(won).toBe(true)
      expect<string>((await rows())[0]?.holder as string).toBe('first')
    })

    test('a key somebody live holds is not', async () => {
      await table().claim(
        { key: 'k', holder: 'first', expiration: now() + 60 },
        ['key'],
        'expiration',
        now()
      )

      const won = await table().claim(
        { key: 'k', holder: 'second', expiration: now() + 60 },
        ['key'],
        'expiration',
        now()
      )

      expect<boolean>(won).toBe(false)
      // And the holder is untouched, which is the whole point of losing.
      expect<string>((await rows())[0]?.holder as string).toBe('first')
    })

    test('but an expired one is taken over', async () => {
      await table().insert({ key: 'k', holder: 'gone', expiration: now() - 10 })

      const won = await table().claim(
        { key: 'k', holder: 'second', expiration: now() + 60 },
        ['key'],
        'expiration',
        now()
      )

      expect<boolean>(won).toBe(true)
      expect<string>((await rows())[0]?.holder as string).toBe('second')
      expect<boolean>(((await rows())[0]?.expiration as number) > now()).toBe(true)
    })

    /** A boundary, because `<=` and `<` differ by exactly this case. */
    test('and one expiring this very second counts as expired', async () => {
      await table().insert({ key: 'k', holder: 'gone', expiration: now() })

      expect<boolean>(
        await table().claim(
          { key: 'k', holder: 'second', expiration: now() + 60 },
          ['key'],
          'expiration',
          now()
        )
      ).toBe(true)
    })

    test('and only one of many claimants on an expired key wins', async () => {
      await table().insert({ key: 'k', holder: 'gone', expiration: now() - 10 })

      const attempts = Array.from({ length: 12 }, (_, index) =>
        table().claim(
          { key: 'k', holder: `c${index}`, expiration: now() + 60 },
          ['key'],
          'expiration',
          now()
        )
      )

      const won = (await Promise.all(attempts)).filter(Boolean).length

      expect<number>(won).toBe(1)
      expect<number>((await rows()).length).toBe(1)
    })

    test('and two different keys do not interfere', async () => {
      expect<boolean>(
        await table().claim(
          { key: 'a', holder: 'x', expiration: now() + 60 },
          ['key'],
          'expiration',
          now()
        )
      ).toBe(true)
      expect<boolean>(
        await table().claim(
          { key: 'b', holder: 'y', expiration: now() + 60 },
          ['key'],
          'expiration',
          now()
        )
      ).toBe(true)
      expect<number>((await rows()).length).toBe(2)
    })
  })
}
