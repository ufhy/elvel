import { beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryException, UniqueConstraintViolation } from '../src/connection/errors.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class Account extends Model {
  static override table = 'accounts'
  static override timestamps = false
  static override fillable = ['email', 'name']

  declare email: string
  declare name: string
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  await new SchemaBuilder(connection).create('accounts', (table) => {
    table.id()
    table.string('email').unique()
    table.string('name').nullable()
  })
})

/** The driver's message alone names a syntax error and not the query. */
describe('a failed query', () => {
  test('carries the statement and the bindings', async () => {
    const failure = await connection
      .select('select * from accounts where nonsense = ?', [1])
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(QueryException)
    expect((failure as QueryException).sql).toContain('nonsense')
    expect((failure as QueryException).bindings).toEqual([1])
    expect((failure as QueryException).message).toContain('SQL:')
  })

  test('and keeps the driver error underneath', async () => {
    const failure = (await connection
      .select('select * from nope')
      .catch((error: unknown) => error)) as QueryException

    expect(failure.cause).toBeDefined()
  })
})

/** Told apart from every other failure, across three dialects. */
describe('a duplicate key', () => {
  test('is its own type', async () => {
    await Account.create({ email: 'ada@example.com' })

    const failure = await Account.create({ email: 'ada@example.com' }).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(UniqueConstraintViolation)
    expect(failure).toBeInstanceOf(QueryException)
  })
})

describe('createOrFirst', () => {
  test('creates when nobody has', async () => {
    const created = await Account.query().createOrFirst(
      { email: 'grace@example.com' },
      { name: 'Grace' }
    )

    expect(created.name).toBe('Grace')
  })

  /** The unique index is the arbiter, so losing the race is an expected outcome. */
  test('and reads back the row somebody else inserted', async () => {
    await Account.create({ email: 'ada@example.com', name: 'Ada' })

    const again = await Account.query().createOrFirst(
      { email: 'ada@example.com' },
      { name: 'Someone else' }
    )

    expect(again.name).toBe('Ada')
    expect(await Account.query().count()).toBe(1)
  })

  /** Swallowing it would return the wrong row, or none at all. */
  test('a violation with nothing to read back is rethrown', async () => {
    await Account.create({ email: 'ada@example.com' })

    const failure = await Account.query()
      // Matches nothing: the conflict is on `email` and the read is on `name`.
      .createOrFirst({ name: 'never-stored' }, { email: 'ada@example.com' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UniqueConstraintViolation)
  })
})
