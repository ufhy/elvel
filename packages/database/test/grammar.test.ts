import { describe, expect, test } from 'bun:test'
import { raw } from '../src/query/expression.ts'
import type { Grammar } from '../src/query/grammar.ts'
import { MariaDbGrammar, MySqlGrammar } from '../src/query/grammars/mysql.ts'
import { PostgresGrammar } from '../src/query/grammars/postgres.ts'
import { SQLiteGrammar } from '../src/query/grammars/sqlite.ts'
import { emptyQuery, type QueryComponents } from '../src/query/types.ts'

const sqlite = new SQLiteGrammar()
const mysql = new MySqlGrammar()
const postgres = new PostgresGrammar()

function query(overrides: Partial<QueryComponents> = {}): QueryComponents {
  return { ...emptyQuery('users'), ...overrides }
}

describe('identifier quoting', () => {
  test('each dialect uses its own quote character', () => {
    expect(sqlite.wrap('users')).toBe('"users"')
    expect(postgres.wrap('users')).toBe('"users"')
    expect(mysql.wrap('users')).toBe('`users`')
  })

  test('qualified names are quoted per segment', () => {
    expect(sqlite.wrap('users.name')).toBe('"users"."name"')
    expect(mysql.wrap('users.name')).toBe('`users`.`name`')
  })

  test('a star is never quoted', () => {
    expect(sqlite.wrap('*')).toBe('*')
    expect(sqlite.wrap('users.*')).toBe('"users".*')
  })

  test('aliases keep their AS', () => {
    expect(sqlite.wrap('users.name as author')).toBe('"users"."name" as "author"')
  })

  test('an embedded quote is escaped by doubling', () => {
    expect(sqlite.wrap('we"ird')).toBe('"we""ird"')
    expect(mysql.wrap('we`ird')).toBe('`we``ird`')
  })

  test('raw expressions pass through untouched', () => {
    expect(sqlite.wrap(raw('count(*)'))).toBe('count(*)')
  })
})

describe('placeholders', () => {
  test('postgres numbers them, the others do not', () => {
    expect(sqlite.parameter(1)).toBe('?')
    expect(mysql.parameter(3)).toBe('?')
    expect(postgres.parameter(1)).toBe('$1')
    expect(postgres.parameter(3)).toBe('$3')
  })

  test('a multi-clause query numbers postgres placeholders in order', () => {
    const compiled = postgres.compileSelect(
      query({
        wheres: [
          { type: 'basic', column: 'name', operator: '=', value: 'Ada', boolean: 'and' },
          { type: 'basic', column: 'age', operator: '>', value: 30, boolean: 'and' }
        ]
      })
    )

    expect(compiled.sql).toBe('select * from "users" where "name" = $1 and "age" > $2')
    expect(compiled.bindings).toEqual(['Ada', 30])
  })
})

describe('select clause order', () => {
  test('follows the order Laravel compiles components in', () => {
    const compiled = sqlite.compileSelect(
      query({
        columns: ['id', 'name'],
        joins: [
          {
            type: 'left',
            table: 'posts',
            wheres: [
              {
                type: 'column',
                first: 'posts.user_id',
                operator: '=',
                second: 'users.id',
                boolean: 'and'
              }
            ]
          }
        ],
        wheres: [{ type: 'basic', column: 'active', operator: '=', value: 1, boolean: 'and' }],
        groups: ['users.id'],
        havings: [{ type: 'raw', sql: 'count(*) > 1', bindings: [], boolean: 'and' }],
        orders: [{ column: 'name', direction: 'asc' }],
        limit: 10,
        offset: 20
      })
    )

    expect(compiled.sql).toBe(
      'select "id", "name" from "users" left join "posts" on "posts"."user_id" = "users"."id" ' +
        'where "active" = ? group by "users"."id" having count(*) > 1 order by "name" asc limit 10 offset 20'
    )
  })

  test('distinct and aggregates', () => {
    expect(sqlite.compileSelect(query({ distinct: true })).sql).toBe(
      'select distinct * from "users"'
    )

    expect(sqlite.compileSelect(query({ aggregate: { fn: 'count', column: '*' } })).sql).toBe(
      'select count(*) as aggregate from "users"'
    )

    expect(
      sqlite.compileSelect(query({ distinct: true, aggregate: { fn: 'count', column: 'email' } }))
        .sql
    ).toBe('select count(distinct "email") as aggregate from "users"')
  })

  test('limit and offset are coerced to numbers, never interpolated raw', () => {
    const compiled = sqlite.compileSelect(query({ limit: Number('5'), offset: Number('10') }))

    expect(compiled.sql).toEndWith('limit 5 offset 10')
  })
})

describe('where clauses', () => {
  const compile = (grammar: Grammar, wheres: QueryComponents['wheres']) =>
    grammar.compileSelect(query({ wheres }))

  test('null checks', () => {
    expect(
      compile(sqlite, [{ type: 'null', column: 'deleted_at', not: false, boolean: 'and' }]).sql
    ).toEndWith('where "deleted_at" is null')
    expect(
      compile(sqlite, [{ type: 'null', column: 'deleted_at', not: true, boolean: 'and' }]).sql
    ).toEndWith('where "deleted_at" is not null')
  })

  test('in with values, and the empty case', () => {
    const populated = compile(sqlite, [
      { type: 'in', column: 'id', values: [1, 2, 3], not: false, boolean: 'and' }
    ])
    expect(populated.sql).toEndWith('where "id" in (?, ?, ?)')
    expect(populated.bindings).toEqual([1, 2, 3])

    // An empty IN must match nothing rather than produce invalid SQL.
    expect(
      compile(sqlite, [{ type: 'in', column: 'id', values: [], not: false, boolean: 'and' }]).sql
    ).toEndWith('where 0 = 1')
    expect(
      compile(sqlite, [{ type: 'in', column: 'id', values: [], not: true, boolean: 'and' }]).sql
    ).toEndWith('where 1 = 1')
  })

  test('between binds both bounds in order', () => {
    const compiled = compile(sqlite, [
      { type: 'between', column: 'age', values: [18, 65], not: false, boolean: 'and' }
    ])

    expect(compiled.sql).toEndWith('where "age" between ? and ?')
    expect(compiled.bindings).toEqual([18, 65])
  })

  test('postgres numbers between placeholders correctly', () => {
    const compiled = compile(postgres, [
      { type: 'basic', column: 'name', operator: '=', value: 'x', boolean: 'and' },
      { type: 'between', column: 'age', values: [18, 65], not: false, boolean: 'and' }
    ])

    expect(compiled.sql).toEndWith('where "name" = $1 and "age" between $2 and $3')
    expect(compiled.bindings).toEqual(['x', 18, 65])
  })

  test('nested groups keep their parentheses and boolean', () => {
    const compiled = compile(sqlite, [
      { type: 'basic', column: 'active', operator: '=', value: 1, boolean: 'and' },
      {
        type: 'nested',
        boolean: 'or',
        wheres: [
          { type: 'basic', column: 'role', operator: '=', value: 'admin', boolean: 'and' },
          { type: 'basic', column: 'role', operator: '=', value: 'owner', boolean: 'or' }
        ]
      }
    ])

    expect(compiled.sql).toEndWith('where "active" = ? or ("role" = ? or "role" = ?)')
    expect(compiled.bindings).toEqual([1, 'admin', 'owner'])
  })

  test('raw wheres contribute their own bindings', () => {
    const compiled = compile(sqlite, [
      { type: 'raw', sql: 'length(name) > ?', bindings: [3], boolean: 'and' }
    ])

    expect(compiled.sql).toEndWith('where length(name) > ?')
    expect(compiled.bindings).toEqual([3])
  })

  test('a raw value is inlined rather than bound', () => {
    const compiled = compile(sqlite, [
      { type: 'basic', column: 'created_at', operator: '<', value: raw('now()'), boolean: 'and' }
    ])

    expect(compiled.sql).toEndWith('where "created_at" < now()')
    expect(compiled.bindings).toEqual([])
  })

  test('exists nests a full subquery and its bindings', () => {
    const compiled = compile(sqlite, [
      {
        type: 'exists',
        not: false,
        boolean: 'and',
        query: {
          ...emptyQuery('posts'),
          columns: [raw('1')],
          wheres: [
            { type: 'basic', column: 'posts.user_id', operator: '=', value: 7, boolean: 'and' }
          ]
        }
      }
    ])

    expect(compiled.sql).toEndWith(
      'where exists (select 1 from "posts" where "posts"."user_id" = ?)'
    )
    expect(compiled.bindings).toEqual([7])
  })
})

describe('locks', () => {
  test('differ per dialect, and sqlite has none', () => {
    expect(sqlite.compileSelect(query({ lock: 'update' })).sql).toBe('select * from "users"')
    expect(mysql.compileSelect(query({ lock: 'update' })).sql).toEndWith('for update')
    expect(mysql.compileSelect(query({ lock: 'share' })).sql).toEndWith('lock in share mode')
    expect(postgres.compileSelect(query({ lock: 'share' })).sql).toEndWith('for share')
  })
})

describe('inserts', () => {
  test('single and batch share one column list', () => {
    const single = sqlite.compileInsert('users', [{ name: 'Ada', email: 'a@b.c' }])
    expect(single.sql).toBe('insert into "users" ("name", "email") values (?, ?)')

    const batch = sqlite.compileInsert('users', [
      { name: 'Ada', email: 'a@b.c' },
      { name: 'Linus', email: 'l@b.c' }
    ])
    expect(batch.sql).toBe('insert into "users" ("name", "email") values (?, ?), (?, ?)')
    expect(batch.bindings).toEqual(['Ada', 'a@b.c', 'Linus', 'l@b.c'])
  })

  test('undefined becomes null rather than a missing binding', () => {
    const compiled = sqlite.compileInsert('users', [{ name: 'Ada', email: undefined }])

    expect(compiled.bindings).toEqual(['Ada', null])
  })

  test('insert-or-ignore differs sharply per dialect', () => {
    const rows = [{ name: 'Ada' }]

    expect(sqlite.compileInsertOrIgnore('users', rows).sql).toStartWith('insert or ignore into')
    expect(mysql.compileInsertOrIgnore('users', rows).sql).toStartWith('insert ignore into')
    expect(postgres.compileInsertOrIgnore('users', rows).sql).toEndWith('on conflict do nothing')
  })

  test('upsert: postgres and sqlite target the conflict, mysql cannot', () => {
    const rows = [{ email: 'a@b.c', name: 'Ada' }]

    expect(sqlite.compileUpsert('users', rows, ['email'], ['name']).sql).toEndWith(
      'on conflict ("email") do update set "name" = excluded."name"'
    )
    expect(postgres.compileUpsert('users', rows, ['email'], ['name']).sql).toEndWith(
      'on conflict ("email") do update set "name" = excluded."name"'
    )
    expect(mysql.compileUpsert('users', rows, ['email'], ['name']).sql).toEndWith(
      'on duplicate key update `name` = values(`name`)'
    )
  })
})

describe('updates and deletes', () => {
  test('update binds values before where bindings', () => {
    const compiled = sqlite.compileUpdate(
      query({ wheres: [{ type: 'basic', column: 'id', operator: '=', value: 7, boolean: 'and' }] }),
      { name: 'Ada', votes: 2 }
    )

    expect(compiled.sql).toBe('update "users" set "name" = ?, "votes" = ? where "id" = ?')
    expect(compiled.bindings).toEqual(['Ada', 2, 7])
  })

  test('postgres numbers update placeholders across both clauses', () => {
    const compiled = postgres.compileUpdate(
      query({ wheres: [{ type: 'basic', column: 'id', operator: '=', value: 7, boolean: 'and' }] }),
      { name: 'Ada' }
    )

    expect(compiled.sql).toBe('update "users" set "name" = $1 where "id" = $2')
  })

  test('a raw update value is inlined, which is what increment relies on', () => {
    const compiled = sqlite.compileUpdate(query(), { votes: raw('"votes" + 1') })

    expect(compiled.sql).toBe('update "users" set "votes" = "votes" + 1')
    expect(compiled.bindings).toEqual([])
  })

  test('delete respects wheres', () => {
    const compiled = sqlite.compileDelete(
      query({ wheres: [{ type: 'basic', column: 'id', operator: '=', value: 1, boolean: 'and' }] })
    )

    expect(compiled.sql).toBe('delete from "users" where "id" = ?')
  })

  test('truncate: sqlite needs two statements, postgres resets identity', () => {
    expect(sqlite.compileTruncate('users')).toEqual([
      "delete from sqlite_sequence where name = 'users'",
      'delete from "users"'
    ])
    expect(postgres.compileTruncate('users')).toEqual(['truncate "users" restart identity cascade'])
    expect(mysql.compileTruncate('users')).toEqual(['truncate table `users`'])
  })
})

describe('capabilities', () => {
  test('RETURNING support is declared per dialect', () => {
    expect(sqlite.supportsReturning()).toBe(true)
    expect(postgres.supportsReturning()).toBe(true)
    expect(new MariaDbGrammar().supportsReturning()).toBe(true)
    expect(mysql.supportsReturning()).toBe(false)
  })

  test('operators are validated against a known list', () => {
    expect(sqlite.isValidOperator('=')).toBe(true)
    expect(sqlite.isValidOperator('LIKE')).toBe(true)
    expect(sqlite.isValidOperator('; drop table users')).toBe(false)
  })
})

describe('boolean defaults', () => {
  test('postgres needs true/false where the others accept 1/0', () => {
    const { Blueprint } = require('../src/schema/blueprint.ts')
    const { SQLiteSchemaGrammar } = require('../src/schema/grammars/sqlite.ts')
    const { PostgresSchemaGrammar } = require('../src/schema/grammars/postgres.ts')

    const plan = new Blueprint('users').create()
    plan.boolean('active').default(true)

    expect(new SQLiteSchemaGrammar().compile(plan)[0]).toContain('default 1')
    // Postgres rejects `default 1` on a boolean column outright.
    expect(new PostgresSchemaGrammar().compile(plan)[0]).toContain('default true')
  })
})
