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

/** MariaDB inherits MySQL's grammar; asserted once, where the two could drift. */
const mariadb = new MariaDbGrammar()

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

describe('JSON paths and containment', () => {
  const contains = (value: unknown): QueryComponents =>
    query({
      wheres: [{ type: 'jsonContains', column: 'meta->tags', value, not: false, boolean: 'and' }]
    })

  const path = (): QueryComponents =>
    query({
      wheres: [
        { type: 'basic', column: 'meta->theme', operator: '=', value: 'dark', boolean: 'and' }
      ]
    })

  test('a -> column compiles per dialect', () => {
    expect(sqlite.compileSelect(path()).sql).toContain(`json_extract("meta", '$."theme"')`)
    // Unquoted on MySQL, so the comparison is against the string, not `"dark"`.
    expect(mysql.compileSelect(path()).sql).toContain('json_unquote(json_extract(`meta`')

    const nested = query({
      wheres: [
        {
          type: 'basic',
          column: 'meta->prefs->theme',
          operator: '=',
          value: 'dark',
          boolean: 'and'
        }
      ]
    })
    expect(postgres.compileSelect(nested).sql).toContain(`("meta")::jsonb->'prefs'->>'theme'`)
  })

  test('whereJsonContains compiles per dialect', () => {
    // SQLite walks the array with json_each; there is no json_contains there.
    expect(sqlite.compileSelect(contains('a')).sql).toContain('exists (select 1 from json_each(')
    expect(mysql.compileSelect(contains('a')).sql).toContain('json_contains(')
    expect(postgres.compileSelect(contains('a')).sql).toContain(`->'tags' @> $1::jsonb`)
  })

  test('the bindings differ where the semantics do', () => {
    // json_each yields scalars, so SQLite binds the raw value; the other two
    // compare documents, so they bind JSON.
    expect(sqlite.compileSelect(contains('a')).bindings).toEqual(['a'])
    expect(mysql.compileSelect(contains('a')).bindings).toEqual(['"a"'])
    // Raw on Postgres too — Bun's driver JSON-encodes a jsonb-cast parameter
    // itself, so stringifying here would encode it twice.
    expect(postgres.compileSelect(contains('a')).bindings).toEqual(['a'])
  })

  test('full text compiles on mysql and postgres, and refuses on sqlite', () => {
    const fullText = (): QueryComponents =>
      query({
        wheres: [{ type: 'fullText', columns: ['title', 'body'], value: 'needle', boolean: 'and' }]
      })

    expect(mysql.compileSelect(fullText()).sql).toContain('match (`title`, `body`) against (')
    expect(postgres.compileSelect(fullText()).sql).toContain('plainto_tsquery')
    expect(() => sqlite.compileSelect(fullText())).toThrow(/does not support full-text/)
  })
})

/**
 * The five date comparisons, and the reason they are a clause rather than a
 * `whereRaw` at the call site: no two of these dialects agree.
 *
 * The SQL is Laravel's, from `Grammar::dateBasedWhere` and the two grammars that
 * override it. Getting `whereMonth` subtly wrong returns *some* rows, which is the
 * kind of mistake that survives a review — so each form is pinned here.
 */
describe('date comparisons', () => {
  const compile = (grammar: Grammar, wheres: QueryComponents['wheres']) =>
    grammar.compileSelect(query({ wheres }))

  const dateWhere = (part: 'date' | 'time' | 'day' | 'month' | 'year', value: unknown) => [
    {
      type: 'date' as const,
      part,
      column: 'created_at',
      operator: '=',
      value,
      boolean: 'and' as const
    }
  ]

  test('MySQL extracts with a function of the same name', () => {
    expect(compile(mysql, dateWhere('date', '2026-08-25')).sql).toEndWith(
      'where date(`created_at`) = ?'
    )
    expect(compile(mysql, dateWhere('month', '08')).sql).toEndWith('where month(`created_at`) = ?')
    expect(compile(mariadb, dateWhere('year', '2026')).sql).toEndWith(
      'where year(`created_at`) = ?'
    )
  })

  /**
   * SQLite has no date functions, and the `cast` is not decoration.
   *
   * `strftime` answers text; comparing text to a bound integer compares types
   * first, so `'08' = 8` is false and `whereMonth('created_at', 8)` would answer
   * nothing at all.
   */
  test('SQLite uses strftime, and casts the bound value to text', () => {
    expect(compile(sqlite, dateWhere('date', '2026-08-25')).sql).toEndWith(
      'where strftime(\'%Y-%m-%d\', "created_at") = cast(? as text)'
    )
    expect(compile(sqlite, dateWhere('time', '10:30:00')).sql).toEndWith(
      'where strftime(\'%H:%M:%S\', "created_at") = cast(? as text)'
    )
    expect(compile(sqlite, dateWhere('day', '25')).sql).toEndWith(
      'where strftime(\'%d\', "created_at") = cast(? as text)'
    )
  })

  /**
   * Postgres has both forms and they are not interchangeable: a cast keeps the
   * comparison against a date, while `extract` answers a number.
   */
  test('Postgres casts for a date or a time and extracts for the parts', () => {
    expect(compile(postgres, dateWhere('date', '2026-08-25')).sql).toEndWith(
      'where "created_at"::date = $1'
    )
    expect(compile(postgres, dateWhere('time', '10:30:00')).sql).toEndWith(
      'where "created_at"::time = $1'
    )
    expect(compile(postgres, dateWhere('month', '08')).sql).toEndWith(
      'where extract(month from "created_at") = $1'
    )
  })

  test('the value is bound, never interpolated', () => {
    const compiled = compile(sqlite, dateWhere('year', '2026'))

    expect(compiled.bindings).toEqual(['2026'])
  })
})

/**
 * The `or` twins, sixteen of which were absent while their `and` forms were here.
 *
 * A gap with no workaround: "published, or written by me" is not two `where`
 * calls, and the alternative was `orWhere(query => …)` with the clause rebuilt by
 * hand inside it. The clause types already carried a `boolean`; nothing could set
 * it.
 *
 * Asserted through the compiled SQL rather than by calling each method, because
 * the mistake this guards against is a twin that pushes `'and'` — which no unit
 * test of the method's return value would catch.
 */
describe('or-joined clauses', () => {
  const compile = (grammar: Grammar, wheres: QueryComponents['wheres']) =>
    grammar.compileSelect(query({ wheres }))

  test('a second clause joined with or reads as or', () => {
    const compiled = compile(sqlite, [
      { type: 'basic', column: 'published', operator: '=', value: 1, boolean: 'and' },
      { type: 'null', column: 'deleted_at', not: false, boolean: 'or' }
    ])

    expect(compiled.sql).toEndWith('where "published" = ? or "deleted_at" is null')
  })

  test('between, column and raw all carry it', () => {
    expect(
      compile(sqlite, [
        { type: 'basic', column: 'a', operator: '=', value: 1, boolean: 'and' },
        { type: 'between', column: 'b', values: [1, 2], not: false, boolean: 'or' }
      ]).sql
    ).toEndWith('or "b" between ? and ?')

    expect(
      compile(sqlite, [
        { type: 'basic', column: 'a', operator: '=', value: 1, boolean: 'and' },
        { type: 'column', first: 'x', operator: '=', second: 'y', boolean: 'or' }
      ]).sql
    ).toEndWith('or "x" = "y"')

    expect(
      compile(sqlite, [
        { type: 'basic', column: 'a', operator: '=', value: 1, boolean: 'and' },
        { type: 'raw', sql: 'json_valid(payload)', bindings: [], boolean: 'or' }
      ]).sql
    ).toEndWith('or json_valid(payload)')
  })

  test('and a having does too', () => {
    const compiled = sqlite.compileSelect(
      query({
        groups: ['author_id'],
        havings: [
          { type: 'basic', column: 'total', operator: '>', value: 1, boolean: 'and' },
          { type: 'null', column: 'total', not: true, boolean: 'or' }
        ]
      })
    )

    expect(compiled.sql).toEndWith('having "total" > ? or "total" is not null')
  })
})
