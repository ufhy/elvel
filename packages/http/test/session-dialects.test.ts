import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { ConnectionManager, QueryBuilder } from '@elvel/database'
import { reachable } from '../../../tests/support/dialects.ts'
import { DatabaseSessionDriver } from '../src/session-drivers.ts'

/**
 * The sessions table against real servers, on the one question SQLite cannot
 * answer: how wide is the column?
 *
 * SQLite stores integers dynamically, so a 32-bit declaration holds a 2040
 * timestamp there quite happily — which is exactly why the shape of this bug
 * survives a green suite. Postgres refuses `2^31` in an `integer` column with
 * `out of range`, and MySQL either truncates it or errors depending on strict
 * mode. Neither can be discovered without the servers.
 *
 * The cache's `expiration` column was the same mistake and was caught this way.
 *
 * The matrix itself — reachability, and creating the test database rather than
 * assuming it — is `tests/support/dialects.ts`.
 */

const PREFIX = `sessions_t${Date.now().toString(36)}`
/** Well past 2038, and past what a signed 32-bit column can hold. */
const AFTER_2038 = 2 ** 31 + 86_400

const available = await reachable('sessions')

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

for (const { name, config } of available) {
  describe(`sessions on ${name}`, () => {
    const table = `${PREFIX}_sessions`

    test('last_activity holds a timestamp past 2038', async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', name)
      app.config.set(`database.connections.${name}`, config)

      const db = new ConnectionManager(app)
      const schema = await db.schema()

      // The shape the stub emits, so what is proved here is what a scaffolded
      // application actually gets.
      await schema.create(table, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.foreignId('user_id').nullable().index()
        blueprint.string('ip_address', 45).nullable()
        blueprint.text('user_agent').nullable()
        blueprint.text('payload')
        blueprint.bigInteger('last_activity').index()
      })

      try {
        const connection = await db.connection()
        const query = () => new QueryBuilder(connection, table)
        const driver = new DatabaseSessionDriver(async () => query() as never)

        // Written directly: the driver stamps `now`, and `now` is not the
        // interesting number.
        await query().insert({
          id: 'future',
          payload: Buffer.from(JSON.stringify({ name: 'Ada' })).toString('base64'),
          last_activity: AFTER_2038
        })

        const row = await query().where('id', '=', 'future').first()

        // Exactly, not approximately: a narrow column that silently truncates
        // gives back a number, just not this one.
        expect(Number(row?.last_activity)).toBe(AFTER_2038)
        expect(await driver.read('future')).toEqual({ name: 'Ada' })

        // And the sweep still reasons about it correctly — a session whose
        // activity is in the future is not stale.
        expect(await driver.gc(3600)).toBe(0)

        // While one from the past is, which proves the comparison works at this
        // width rather than merely that nothing threw.
        await query().insert({
          id: 'stale',
          payload: Buffer.from(JSON.stringify({ name: 'Old' })).toString('base64'),
          last_activity: Math.floor(Date.now() / 1000) - 10_000
        })

        expect(await driver.gc(3600)).toBe(1)
        expect(await driver.read('future')).toEqual({ name: 'Ada' })
      } finally {
        await (await db.schema()).dropIfExists(table)
        await db.disconnectAll()
      }
    })

    /**
     * Why the width had to change, asserted rather than claimed.
     *
     * Without this, nothing stops the column being narrowed back to `integer` by
     * somebody matching Laravel more closely, and nothing records that SQLite is
     * incapable of noticing. So: build the old column and watch each dialect
     * disagree — Postgres and MySQL cannot keep the value, SQLite can, because it
     * stores integers by magnitude and treats the declared width as a hint.
     */
    test('the 32-bit column this replaced could not hold it', async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', name)
      app.config.set(`database.connections.${name}`, config)

      const db = new ConnectionManager(app)
      const narrow = `${table}_narrow`

      await (await db.schema()).create(narrow, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.integer('last_activity')
      })

      try {
        const connection = await db.connection()
        const query = () => new QueryBuilder(connection, narrow)

        const stored = await query()
          .insert({ id: 'future', last_activity: AFTER_2038 })
          .then(async () =>
            Number((await query().where('id', '=', 'future').first())?.last_activity)
          )
          .catch(() => 'refused' as const)

        if (name === 'sqlite') {
          // Not a failure — a demonstration that this suite cannot rely on SQLite
          // to catch a width mistake.
          expect(stored).toBe(AFTER_2038)
        } else {
          // Refused outright (Postgres, and MySQL in strict mode) or silently
          // clamped to 2147483647 (MySQL otherwise). Both are the bug.
          expect(stored).not.toBe(AFTER_2038)
        }
      } finally {
        await (await db.schema()).dropIfExists(narrow)
        await db.disconnectAll()
      }
    })
  })
}
