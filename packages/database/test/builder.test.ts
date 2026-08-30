import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { raw } from '../src/query/expression.ts'

let connection: BunSqlConnection

/** Every test runs against a real in-memory SQLite database, not a mock. */
beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', {
    driver: 'sqlite',
    database: ':memory:'
  })

  await connection.unprepared(
    `CREATE TABLE users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       email TEXT UNIQUE,
       votes INTEGER DEFAULT 0,
       active INTEGER DEFAULT 1
     )`
  )
  await connection.unprepared(
    `CREATE TABLE posts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER NOT NULL,
       title TEXT NOT NULL
     )`
  )
})

afterEach(async () => {
  await connection.disconnect()
})

function users() {
  return new QueryBuilder(connection, 'users')
}

async function seed() {
  await users().insert([
    { name: 'Ada', email: 'ada@example.com', votes: 10, active: 1 },
    { name: 'Linus', email: 'linus@example.com', votes: 5, active: 1 },
    { name: 'Grace', email: 'grace@example.com', votes: 20, active: 0 }
  ])
}

describe('inserts', () => {
  test('insert one row and count it', async () => {
    expect(await users().insert({ name: 'Ada', email: 'a@b.c' })).toBe(1)
    expect(await users().count()).toBe(1)
  })

  test('insert many rows in one statement', async () => {
    expect(await users().insert([{ name: 'Ada' }, { name: 'Linus' }])).toBe(2)
    expect(await users().count()).toBe(2)
  })

  test('inserting nothing is a no-op, not an error', async () => {
    expect(await users().insert([])).toBe(0)
  })

  test('insertGetId returns the new key', async () => {
    const first = await users().insertGetId({ name: 'Ada' })
    const second = await users().insertGetId({ name: 'Linus' })

    expect(first).toBe(1)
    expect(second).toBe(2)
  })

  test('insertOrIgnore swallows a unique violation', async () => {
    await users().insert({ name: 'Ada', email: 'dup@example.com' })

    expect(await users().insertOrIgnore({ name: 'Other', email: 'dup@example.com' })).toBe(0)
    expect(await users().count()).toBe(1)
  })

  test('a plain insert still surfaces the violation', async () => {
    await users().insert({ name: 'Ada', email: 'dup@example.com' })

    await expect(users().insert({ name: 'Other', email: 'dup@example.com' })).rejects.toThrow()
  })

  test('upsert inserts, then updates on conflict', async () => {
    await users().upsert({ name: 'Ada', email: 'ada@example.com', votes: 1 }, ['email'])
    await users().upsert({ name: 'Ada Lovelace', email: 'ada@example.com', votes: 9 }, ['email'])

    expect(await users().count()).toBe(1)
    expect(await users().where('email', 'ada@example.com').value<string>('name')).toBe(
      'Ada Lovelace'
    )
    expect(await users().where('email', 'ada@example.com').value<number>('votes')).toBe(9)
  })

  test('upsert can restrict which columns are updated', async () => {
    await users().insert({ name: 'Ada', email: 'ada@example.com', votes: 1 })
    await users().upsert(
      { name: 'Changed', email: 'ada@example.com', votes: 99 },
      ['email'],
      ['votes']
    )

    expect(await users().where('email', 'ada@example.com').value<string>('name')).toBe('Ada')
    expect(await users().where('email', 'ada@example.com').value<number>('votes')).toBe(99)
  })
})

describe('reading', () => {
  beforeEach(seed)

  test('get returns a Collection', async () => {
    const rows = await users().get()

    expect(rows.count()).toBe(3)
    expect(rows.pluck('name').all()).toEqual(['Ada', 'Linus', 'Grace'])
  })

  test('select narrows the columns', async () => {
    const row = await users().select('name').first()

    expect(Object.keys(row ?? {})).toEqual(['name'])
  })

  test('first applies a limit rather than fetching everything', async () => {
    const query = users().orderBy('votes', 'desc')

    expect((await query.first())?.name).toBe('Grace')
    // The builder was not mutated by first(), so it can be reused.
    expect((await query.get()).count()).toBe(3)
  })

  test('find looks up by id', async () => {
    expect((await users().find(2))?.name).toBe('Linus')
    expect(await users().find(99)).toBeUndefined()
  })

  test('value and pluck', async () => {
    expect(await users().where('name', 'Ada').value<string>('email')).toBe('ada@example.com')
    expect((await users().orderBy('name').pluck('name')).all()).toEqual(['Ada', 'Grace', 'Linus'])
  })

  test('exists and doesntExist', async () => {
    expect(await users().where('name', 'Ada').exists()).toBe(true)
    expect(await users().where('name', 'Nobody').exists()).toBe(false)
    expect(await users().where('name', 'Nobody').doesntExist()).toBe(true)
  })

  test('two-argument where means equality', async () => {
    expect(await users().where('votes', 10).count()).toBe(1)
  })

  test('three-argument where uses the operator', async () => {
    expect(await users().where('votes', '>', 5).count()).toBe(2)
    expect(await users().where('votes', '>=', 5).count()).toBe(3)
  })

  test('an unknown operator is rejected instead of injected', () => {
    expect(() => users().where('votes', '); drop table users; --', 1)).toThrow(
      /Unsupported operator/
    )
  })

  test('where with null becomes an is-null check', async () => {
    await users().insert({ name: 'Nameless', email: null })

    expect(await users().whereNull('email').count()).toBe(1)
    expect(await users().where('email', null).count()).toBe(1)
    expect(await users().whereNotNull('email').count()).toBe(3)
  })

  test('orWhere and nested grouping', async () => {
    const count = await users()
      .where('active', 1)
      .where((query) => {
        query.where('votes', '>', 15).orWhere('name', 'Ada')
      })
      .count()

    expect(count).toBe(1)
  })

  test('whereIn, whereNotIn and the empty case', async () => {
    expect(await users().whereIn('name', ['Ada', 'Grace']).count()).toBe(2)
    expect(await users().whereNotIn('name', ['Ada']).count()).toBe(2)
    expect(await users().whereIn('name', []).count()).toBe(0)
    expect(await users().whereNotIn('name', []).count()).toBe(3)
  })

  test('whereBetween', async () => {
    expect(await users().whereBetween('votes', [5, 10]).count()).toBe(2)
    expect(await users().whereNotBetween('votes', [5, 10]).count()).toBe(1)
  })

  test('whereLike', async () => {
    expect(await users().whereLike('email', '%example.com').count()).toBe(3)
  })

  test('whereRaw carries its bindings', async () => {
    expect(await users().whereRaw('length(name) > ?', [4]).count()).toBe(2)
  })

  test('whereColumn compares two columns', async () => {
    expect(await users().whereColumn('votes', '>', 'active').count()).toBe(3)
  })

  test('whereExists against a joined table', async () => {
    await new QueryBuilder(connection, 'posts').insert({ user_id: 1, title: 'Hello' })

    const count = await users()
      .whereExists((query) => {
        query.from('posts').selectRaw('1').whereColumn('posts.user_id', '=', 'users.id')
      })
      .count()

    expect(count).toBe(1)
  })

  test('joins', async () => {
    await new QueryBuilder(connection, 'posts').insert([
      { user_id: 1, title: 'First' },
      { user_id: 1, title: 'Second' },
      { user_id: 3, title: 'Third' }
    ])

    const rows = await users()
      .select('users.name', 'posts.title')
      .join('posts', 'posts.user_id', '=', 'users.id')
      .orderBy('posts.id')
      .get()

    expect(rows.count()).toBe(3)
    expect(rows.first()).toEqual({ name: 'Ada', title: 'First' })

    const left = await users().leftJoin('posts', 'posts.user_id', '=', 'users.id').count()
    expect(left).toBe(4)
  })

  test('groupBy with having', async () => {
    await new QueryBuilder(connection, 'posts').insert([
      { user_id: 1, title: 'a' },
      { user_id: 1, title: 'b' },
      { user_id: 3, title: 'c' }
    ])

    const rows = await new QueryBuilder(connection, 'posts')
      .select('user_id')
      .selectRaw('count(*) as total')
      .groupBy('user_id')
      .havingRaw('count(*) > ?', [1])
      .get()

    expect(rows.count()).toBe(1)
    expect(rows.first()).toMatchObject({ user_id: 1, total: 2 })
  })

  test('ordering, limit and offset', async () => {
    const rows = await users().orderByDesc('votes').limit(2).offset(1).get()

    expect(rows.pluck('name').all()).toEqual(['Ada', 'Linus'])
  })

  test('forPage paginates', async () => {
    expect((await users().orderBy('id').forPage(2, 2).get()).pluck('name').all()).toEqual(['Grace'])
  })

  test('distinct', async () => {
    await users().insert({ name: 'Ada', email: 'second@example.com' })

    expect((await users().select('name').distinct().get()).count()).toBe(3)
  })

  test('chunk walks every row in pages', async () => {
    const seen: string[] = []

    await users()
      .orderBy('id')
      .chunk(2, (rows) => {
        seen.push(...rows.pluck('name').map(String).all())
      })

    expect(seen).toEqual(['Ada', 'Linus', 'Grace'])
  })

  /**
   * Unordered, `chunk` pages by key instead. Nothing was promised about which
   * rows land on which page without an `order by`, so ordering by the key is the
   * stricter reading — and it is what stops the walk stepping over a row when
   * something is deleted while it runs.
   */
  test('an unordered chunk walks by key and survives a delete', async () => {
    const seen: string[] = []

    await users().chunk(2, async (rows) => {
      seen.push(...rows.pluck('name').map(String).all())

      for (const row of rows) await users().where('id', row.id).delete()
    })

    expect<number>(seen.length).toBe(3)
  })

  test('chunk stops early when the callback returns false', async () => {
    const seen: string[] = []

    await users()
      .orderBy('id')
      .chunk(1, (rows) => {
        seen.push(...rows.pluck('name').map(String).all())
        return false
      })

    expect(seen).toEqual(['Ada'])
  })
})

describe('aggregates', () => {
  beforeEach(seed)

  test('count, max, min, sum, avg', async () => {
    expect(await users().count()).toBe(3)
    expect(await users().max<number>('votes')).toBe(20)
    expect(await users().min<number>('votes')).toBe(5)
    expect(await users().sum('votes')).toBe(35)
    expect(await users().avg('votes')).toBeCloseTo(11.666, 2)
  })

  test('aggregates respect wheres but ignore ordering', async () => {
    expect(await users().where('active', 1).orderBy('name').count()).toBe(2)
  })

  test('count on an empty result is zero, and avg is null', async () => {
    const empty = users().where('name', 'Nobody')

    expect(await empty.count()).toBe(0)
    expect(await empty.avg('votes')).toBeNull()
  })

  test('counting a column ignores nulls', async () => {
    await users().insert({ name: 'Nameless', email: null })

    expect(await users().count()).toBe(4)
    expect(await users().count('email')).toBe(3)
  })
})

describe('updates and deletes', () => {
  beforeEach(seed)

  test('update returns the affected count', async () => {
    expect(await users().where('active', 1).update({ votes: 0 })).toBe(2)
    expect(await users().sum('votes')).toBe(20)
  })

  test('increment and decrement without losing other columns', async () => {
    await users().where('name', 'Ada').increment('votes', 5, { active: 0 })

    const ada = await users().where('name', 'Ada').first()
    expect(ada).toMatchObject({ votes: 15, active: 0 })

    await users().where('name', 'Ada').decrement('votes')
    expect(await users().where('name', 'Ada').value<number>('votes')).toBe(14)
  })

  test('updateOrInsert inserts when missing and updates when present', async () => {
    expect(await users().updateOrInsert({ email: 'new@example.com' }, { name: 'New' })).toBe(true)
    expect(await users().count()).toBe(4)

    expect(await users().updateOrInsert({ email: 'new@example.com' }, { name: 'Renamed' })).toBe(
      false
    )
    expect(await users().count()).toBe(4)
    expect(await users().where('email', 'new@example.com').value<string>('name')).toBe('Renamed')
  })

  test('delete with and without a where', async () => {
    expect(await users().where('name', 'Ada').delete()).toBe(1)
    expect(await users().count()).toBe(2)

    expect(await users().delete()).toBe(2)
    expect(await users().count()).toBe(0)
  })

  test('delete by id', async () => {
    await users().delete(2)

    expect(await users().find(2)).toBeUndefined()
  })

  test('truncate empties the table and resets the sequence', async () => {
    await users().truncate()

    expect(await users().count()).toBe(0)
    expect(await users().insertGetId({ name: 'Fresh' })).toBe(1)
  })
})

describe('inspection and composition', () => {
  test('toSql and getBindings need no database round trip', () => {
    const query = users().where('votes', '>', 5).orderBy('name')

    expect(query.toSql()).toBe('select * from "users" where "votes" > ? order by "name" asc')
    expect(query.getBindings()).toEqual([5])
  })

  test('clone isolates further changes', () => {
    const base = users().where('active', 1)
    const filtered = base.clone().where('votes', '>', 5)

    expect(base.getBindings()).toEqual([1])
    expect(filtered.getBindings()).toEqual([1, 5])
  })

  test('when and unless apply conditionally', () => {
    const applied = users().when(true, (query) => query.where('active', 1))
    const skipped = users().when(false, (query) => query.where('active', 1))

    expect(applied.getBindings()).toEqual([1])
    expect(skipped.getBindings()).toEqual([])
    expect(
      users()
        .unless(false, (query) => query.where('active', 1))
        .getBindings()
    ).toEqual([1])
  })

  test('raw expressions reach the database intact', async () => {
    await seed()

    const rows = await users().selectRaw('sum(votes) as total').get()

    expect(rows.first()).toEqual({ total: 35 })
  })

  test('a raw where value is not bound', async () => {
    await seed()

    expect(await users().where('votes', '>', raw('5')).count()).toBe(2)
  })
})

describe('transactions', () => {
  test('commit persists every statement', async () => {
    await connection.transaction(async (tx) => {
      await new QueryBuilder(tx, 'users').insert({ name: 'Ada' })
      await new QueryBuilder(tx, 'users').insert({ name: 'Linus' })
    })

    expect(await users().count()).toBe(2)
  })

  test('a throw rolls everything back and rethrows', async () => {
    await expect(
      connection.transaction(async (tx) => {
        await new QueryBuilder(tx, 'users').insert({ name: 'Ada' })
        throw new Error('nope')
      })
    ).rejects.toThrow('nope')

    expect(await users().count()).toBe(0)
  })

  test('the callback result is returned', async () => {
    const id = await connection.transaction(async (tx) =>
      new QueryBuilder(tx, 'users').insertGetId({ name: 'Ada' })
    )

    expect(id).toBe(1)
  })

  test('a non-deadlock error is not retried', async () => {
    let attempts = 0

    await expect(
      connection.transaction(async () => {
        attempts += 1
        throw new Error('unique constraint failed')
      }, 3)
    ).rejects.toThrow()

    expect(attempts).toBe(1)
  })

  test('a deadlock-shaped error is retried up to the limit', async () => {
    let attempts = 0

    await expect(
      connection.transaction(async () => {
        attempts += 1
        throw new Error('database is locked')
      }, 3)
    ).rejects.toThrow()

    expect(attempts).toBe(3)
  })
})

describe('after-commit callbacks', () => {
  test('a callback runs when the transaction commits, once', async () => {
    const ran: string[] = []

    await connection.transaction(async (tx) => {
      await new QueryBuilder(tx, 'users').insert({ name: 'Ada' })
      await tx.afterCommit(() => ran.push('queued'))

      // Not yet: the rows this callback is about are not committed.
      expect(ran).toEqual([])
    })

    expect(ran).toEqual(['queued'])
  })

  test('and is dropped when it rolls back', async () => {
    const ran: string[] = []

    await expect(
      connection.transaction(async (tx) => {
        await tx.afterCommit(() => ran.push('queued'))
        throw new Error('nope')
      })
    ).rejects.toThrow('nope')

    // The rows it was about never existed, so neither should the work.
    expect(ran).toEqual([])
    // And nothing is left waiting: outside a transaction there is no manager at all.
    expect(connection.transactions).toBeUndefined()
  })

  test('outside a transaction it runs immediately', async () => {
    const ran: string[] = []

    await connection.afterCommit(() => ran.push('now'))

    // This is what lets a caller mark work afterCommit unconditionally.
    expect(ran).toEqual(['now'])
  })

  test('a nested commit waits for the outermost one', async () => {
    const ran: string[] = []

    await connection.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.afterCommit(() => ran.push('inner'))
      })

      // The inner block finished, but the outer one can still roll it all back.
      expect(ran).toEqual([])

      await tx.afterCommit(() => ran.push('outer'))
    })

    expect(ran).toEqual(['inner', 'outer'])
  })

  test('an outer rollback discards what the inner block deferred', async () => {
    const ran: string[] = []

    await expect(
      connection.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.afterCommit(() => ran.push('inner'))
        })

        throw new Error('nope')
      })
    ).rejects.toThrow('nope')

    expect(ran).toEqual([])
  })

  test('registering from the outer connection lands in the same transaction', async () => {
    const ran: string[] = []

    await connection.transaction(async () => {
      // The case this feature exists for: whatever defers the work — an event
      // dispatcher, a queue manager — holds the application's connection, not the
      // `tx` some service method three frames up was handed. It is found in async
      // context instead, and must still be deferred.
      await connection.afterCommit(() => ran.push('deferred'))

      expect(ran).toEqual([])
    })

    expect(ran).toEqual(['deferred'])
  })

  test('a nested transaction is a savepoint, so it can be nested at all', async () => {
    // In-memory SQLite has one connection, so two *concurrent* transactions are
    // impossible here — the dialect suite covers that against Postgres and MySQL.
    await connection.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await new QueryBuilder(inner, 'users').insert({ name: 'Ada' })
      })

      expect(await new QueryBuilder(tx, 'users').count()).toBe(1)
    })

    expect(await users().count()).toBe(1)
  })
})

describe('query events', () => {
  test('every query is announced with its sql, bindings and duration', async () => {
    const seen: Array<{ sql: string; bindings: unknown[]; time: number }> = []

    const instrumented = await BunSqlConnection.make(
      'instrumented',
      { driver: 'sqlite', database: ':memory:' },
      {
        dispatch: async (event: unknown) => {
          seen.push(event as { sql: string; bindings: unknown[]; time: number })
          return []
        }
      } as never
    )

    await instrumented.unprepared('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await new QueryBuilder(instrumented, 't').where('name', 'Ada').get()
    await instrumented.disconnect()

    const select = seen.find((event) => event.sql.startsWith('select'))

    expect(select?.sql).toBe('select * from "t" where "name" = ?')
    expect(select?.bindings).toEqual(['Ada'])
    expect(select?.time).toBeGreaterThanOrEqual(0)
  })
})
