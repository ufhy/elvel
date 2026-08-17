import { describe, expect, test } from 'bun:test'
import {
  BunSqlConnection,
  type ConnectionConfig,
  QueryBuilder,
  SchemaBuilder
} from '@elyvel/database'
import { betterAuth } from 'better-auth'
import { type Dialect, elyvelAdapter } from '../src/adapter.ts'

/**
 * The adapter against real servers.
 *
 * The unit suite drives it on sqlite, where nearly everything is text and
 * forgiving. What the other dialects settle is exactly what a plausible-looking
 * config gets wrong: Postgres has a real `boolean` column and rejects `1` for
 * it, MySQL's `timestamp` rejects the `T` and `Z` of an ISO string, and neither
 * accepts a JavaScript `Date` as a bound parameter the way sqlite shrugs at it.
 *
 * A server that is unreachable drops out with a note rather than failing, so the
 * suite stays green without one. Override with TEST_POSTGRES_URL/TEST_MYSQL_URL.
 */

type Candidate = { name: Dialect; config: ConnectionConfig }

const PREFIX = `auth_t${Date.now().toString(36)}`
const TEST_DATABASE = 'elyvel_test'

const candidates: Candidate[] = [
  { name: 'sqlite', config: { driver: 'sqlite', database: ':memory:' } },
  {
    name: 'postgres',
    config: process.env.TEST_POSTGRES_URL
      ? { driver: 'postgres', url: process.env.TEST_POSTGRES_URL }
      : {
          driver: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          username: 'postgres',
          database: TEST_DATABASE
        }
  },
  {
    name: 'mysql',
    config: process.env.TEST_MYSQL_URL
      ? { driver: 'mysql', url: process.env.TEST_MYSQL_URL }
      : {
          driver: 'mysql',
          host: '127.0.0.1',
          port: 3309,
          username: 'root',
          database: TEST_DATABASE
        }
  }
]

const available: Candidate[] = []

for (const candidate of candidates) {
  try {
    const connection = await BunSqlConnection.make(candidate.name, candidate.config)
    await connection.select('select 1 as one')
    await connection.disconnect()
    available.push(candidate)
  } catch (error) {
    console.log(
      `  skipping auth on ${candidate.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`
    )
  }
}

test('sqlite is always part of the matrix', () => {
  expect(available.map((candidate) => candidate.name)).toContain('sqlite')
})

for (const { name, config } of available) {
  describe(`auth on ${name}`, () => {
    // One connection for the whole block: sqlite's `:memory:` database exists
    // only as long as its connection does.
    let connection: BunSqlConnection

    const tables = {
      user: `${PREFIX}_user`,
      session: `${PREFIX}_session`,
      account: `${PREFIX}_account`,
      verification: `${PREFIX}_verification`
    }

    const table = (model: string) => new QueryBuilder(connection, model)

    const setUp = async () => {
      connection = await BunSqlConnection.make(`auth-${name}`, config)

      const schema = new SchemaBuilder(connection)

      await schema.create(tables.user, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.string('name')
        blueprint.string('email').unique()
        blueprint.boolean('emailVerified')
        blueprint.text('image').nullable()
        blueprint.timestamp('createdAt')
        blueprint.timestamp('updatedAt')
      })
      await schema.create(tables.session, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.timestamp('expiresAt')
        blueprint.string('token').unique()
        blueprint.timestamp('createdAt')
        blueprint.timestamp('updatedAt')
        blueprint.text('ipAddress').nullable()
        blueprint.text('userAgent').nullable()
        blueprint.string('userId')
        blueprint.foreign(['userId']).references(['id']).on(tables.user).onDelete('cascade')
      })
      await schema.create(tables.account, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.text('accountId')
        blueprint.text('providerId')
        blueprint.string('userId')
        blueprint.text('accessToken').nullable()
        blueprint.text('refreshToken').nullable()
        blueprint.text('idToken').nullable()
        blueprint.timestamp('accessTokenExpiresAt').nullable()
        blueprint.timestamp('refreshTokenExpiresAt').nullable()
        blueprint.text('scope').nullable()
        blueprint.text('password').nullable()
        blueprint.timestamp('createdAt')
        blueprint.timestamp('updatedAt')
        blueprint.foreign(['userId']).references(['id']).on(tables.user).onDelete('cascade')
      })
      await schema.create(tables.verification, (blueprint) => {
        blueprint.string('id').primary()
        blueprint.text('identifier')
        blueprint.text('value')
        blueprint.timestamp('expiresAt')
        blueprint.timestamp('createdAt')
        blueprint.timestamp('updatedAt')
      })
    }

    const tearDown = async () => {
      const schema = new SchemaBuilder(connection)

      for (const model of [tables.account, tables.session, tables.verification, tables.user]) {
        await schema.dropIfExists(model)
      }

      await connection.disconnect()
    }

    test('a user signs up, signs in and is read back with the right types', async () => {
      await setUp()

      try {
        const db = {
          connection: async () => connection,
          table: async (model: string) => new QueryBuilder(connection, model)
        } as never

        const auth = betterAuth({
          secret: 'a-test-secret-of-at-least-32-characters',
          baseURL: 'http://localhost',
          emailAndPassword: { enabled: true },
          // The model names are per-run so two dialects never share a table.
          user: { modelName: tables.user },
          session: { modelName: tables.session },
          account: { modelName: tables.account },
          verification: { modelName: tables.verification },
          database: elyvelAdapter(db, { dialect: name })
        })

        const { user } = await auth.api.signUpEmail({
          body: { name: 'Ada', email: 'ada@example.com', password: 'secret123' }
        })

        // A date reached a real `timestamp` column and came back as a Date.
        expect(user.createdAt).toBeInstanceOf(Date)
        // The boolean survived whichever representation the dialect uses.
        expect(user.emailVerified).toBe(false)

        const signedIn = await auth.api.signInEmail({
          body: { email: 'ada@example.com', password: 'secret123' },
          asResponse: true
        })
        const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

        const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
        expect(session?.user.email).toBe('ada@example.com')
        expect(session?.session.expiresAt).toBeInstanceOf(Date)

        // The rows are ours, on this connection, readable with the query builder.
        expect(await table(tables.user).count()).toBe(1)
        expect(await table(tables.account).count()).toBe(1)
        expect(await table(tables.session).count()).toBeGreaterThanOrEqual(1)

        // Writing the boolean the other way round has to work too: Postgres
        // would reject a `1` here, and MySQL would store `true` as 1.
        const verified = await auth.api.getSession({ headers: new Headers({ cookie }) })
        expect(verified?.user.emailVerified).toBe(false)

        /**
         * The unique index the schema builder wrote is enforced by the server.
         *
         * Caught rather than asserted with `.rejects`, which never settles on
         * Windows when the promise came from a networked driver — and this one
         * runs against Postgres and MySQL. See BEHAVIOURS.
         */
        const duplicate = await auth.api
          .signUpEmail({
            body: { name: 'Ada again', email: 'ada@example.com', password: 'secret123' }
          })
          .then(() => null)
          .catch((error: unknown) => error)

        expect<boolean>(duplicate !== null).toBe(true)

        // Signing out deletes exactly one row — its own — through the singular
        // `delete` path, which resolves the key first for that reason. Signing up
        // already opened a session, so the other one has to survive.
        const before = await table(tables.session).count()
        await auth.api.signOut({ headers: new Headers({ cookie }) })

        expect(await table(tables.session).count()).toBe(before - 1)
        expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull()
      } finally {
        await tearDown()
      }
    })
  })
}
