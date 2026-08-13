import { type Expression, isExpression } from './expression.ts'
import type { QueryComponents, WhereClause } from './types.ts'

/**
 * Compiles a query description into SQL plus its bindings.
 *
 * The component order is taken from `Illuminate\Database\Query\Grammars\Grammar`
 * — `aggregate, columns, from, indexHint, joins, wheres, groups, havings,
 * orders, limit, offset, lock` — because clause order is not free-form SQL.
 *
 * Unlike Laravel we cannot assume `?` everywhere: PDO normalises placeholders,
 * Bun.SQL does not, so `parameter()` is a per-dialect concern.
 */
export abstract class Grammar {
  /** Identifier quote character. MySQL overrides this with a backtick. */
  protected quote = '"'

  /** Operators the builder accepts in a where clause. */
  protected readonly operators = new Set([
    '=',
    '<',
    '>',
    '<=',
    '>=',
    '<>',
    '!=',
    '<=>',
    'like',
    'not like',
    'ilike',
    'not ilike',
    'in',
    'not in',
    'is',
    'is not',
    '&',
    '|',
    '^',
    '<<',
    '>>',
    '~',
    '@>',
    '<@',
    '?',
    '?|',
    '?&'
  ])

  abstract get dialect(): 'sqlite' | 'mysql' | 'mariadb' | 'postgres'

  isValidOperator(operator: string): boolean {
    return this.operators.has(operator.toLowerCase())
  }

  /**
   * Placeholder for binding number `index` (1-based).
   * Postgres needs `$1`; everything we target accepts `?`.
   */
  parameter(_index: number): string {
    return '?'
  }

  /** Quote an identifier, allowing `table.column`, aliases and `*`. */
  wrap(value: string | Expression): string {
    if (isExpression(value)) return value.value

    if (/ as /i.test(value)) {
      const [target, alias] = value.split(/ as /i)
      return `${this.wrap((target as string).trim())} as ${this.wrapValue((alias as string).trim())}`
    }

    return value
      .split('.')
      .map((segment) => this.wrapValue(segment))
      .join('.')
  }

  wrapTable(table: string | Expression): string {
    return this.wrap(table)
  }

  protected wrapValue(value: string): string {
    if (value === '*') return value

    // Double the quote character to escape it, as Laravel's Grammar does.
    return `${this.quote}${value.replaceAll(this.quote, this.quote + this.quote)}${this.quote}`
  }

  columnize(columns: Array<string | Expression>): string {
    return columns.map((column) => this.wrap(column)).join(', ')
  }

  // ------------------------------------------------------------------ select

  compileSelect(query: QueryComponents): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = []
    const parts: string[] = []

    if (query.aggregate) {
      const column = query.aggregate.column === '*' ? '*' : this.wrap(query.aggregate.column)
      const inner = query.distinct && column !== '*' ? `distinct ${column}` : column
      parts.push(`select ${query.aggregate.fn}(${inner}) as aggregate`)
    } else {
      const columns = query.columns.length > 0 ? this.columnize(query.columns) : '*'
      parts.push(`select ${query.distinct ? 'distinct ' : ''}${columns}`)
    }

    parts.push(`from ${this.wrapTable(query.from)}`)

    for (const join of query.joins) {
      // The joined table's own bindings come first: a subquery is written before
      // the `on` that follows it, so its placeholders are read first too.
      if (join.bindings) bindings.push(...join.bindings)

      const on = this.compileWheres(join.wheres, bindings, 'on')
      parts.push(`${join.type} join ${this.wrapTable(join.table)}${on ? ` on ${on}` : ''}`)
    }

    const wheres = this.compileWheres(query.wheres, bindings)
    if (wheres) parts.push(`where ${wheres}`)

    if (query.groups.length > 0) parts.push(`group by ${this.columnize(query.groups)}`)

    const havings = this.compileWheres(query.havings, bindings, 'having')
    if (havings) parts.push(`having ${havings}`)

    if (query.orders.length > 0) {
      const orders = query.orders
        .map((order) =>
          isExpression(order.column)
            ? order.column.value
            : `${this.wrap(order.column)} ${order.direction}`
        )
        .join(', ')
      parts.push(`order by ${orders}`)
    }

    if (query.limit !== undefined) parts.push(`limit ${Number(query.limit)}`)
    if (query.offset !== undefined) parts.push(`offset ${Number(query.offset)}`)

    if (query.lock !== undefined) {
      const lock = this.compileLock(query.lock)
      if (lock) parts.push(lock)
    }

    return { sql: parts.join(' '), bindings }
  }

  /** `for update` / `lock in share mode`. SQLite has no row locks. */
  protected compileLock(_lock: 'update' | 'share'): string {
    return ''
  }

  // ------------------------------------------------------------------ wheres

  protected compileWheres(
    wheres: WhereClause[],
    bindings: unknown[],
    context: 'where' | 'on' | 'having' = 'where'
  ): string {
    const compiled: string[] = []

    for (const [index, where] of wheres.entries()) {
      const boolean = index === 0 ? '' : `${where.boolean} `
      compiled.push(`${boolean}${this.compileWhere(where, bindings, context)}`)
    }

    return compiled.join(' ')
  }

  protected compileWhere(
    where: WhereClause,
    bindings: unknown[],
    context: 'where' | 'on' | 'having'
  ): string {
    switch (where.type) {
      case 'basic': {
        if (isExpression(where.value)) {
          return `${this.wrap(where.column)} ${where.operator} ${where.value.value}`
        }
        bindings.push(where.value)
        return `${this.wrap(where.column)} ${where.operator} ${this.parameter(bindings.length)}`
      }

      case 'column':
        return `${this.wrap(where.first)} ${where.operator} ${this.wrap(where.second)}`

      case 'null':
        return `${this.wrap(where.column)} is ${where.not ? 'not ' : ''}null`

      case 'in': {
        if (where.values.length === 0) {
          // An empty IN can never match; emit a constant so the SQL stays valid.
          return where.not ? '1 = 1' : '0 = 1'
        }
        const placeholders = where.values
          .map((value) => {
            bindings.push(value)
            return this.parameter(bindings.length)
          })
          .join(', ')
        return `${this.wrap(where.column)} ${where.not ? 'not in' : 'in'} (${placeholders})`
      }

      case 'between': {
        bindings.push(where.values[0], where.values[1])
        const low = this.parameter(bindings.length - 1)
        const high = this.parameter(bindings.length)
        return `${this.wrap(where.column)} ${where.not ? 'not between' : 'between'} ${low} and ${high}`
      }

      case 'exists': {
        const inner = this.compileSelect(where.query)
        bindings.push(...inner.bindings)
        return `${where.not ? 'not exists' : 'exists'} (${inner.sql})`
      }

      case 'nested': {
        const inner = this.compileWheres(where.wheres, bindings, context)
        return `(${inner})`
      }

      case 'raw': {
        bindings.push(...where.bindings)
        return where.sql
      }

      default: {
        const exhaustive: never = where
        throw new Error(`Unsupported where clause: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  // ------------------------------------------------------------------ writes

  compileInsert(
    table: string,
    rows: Array<Record<string, unknown>>
  ): { sql: string; bindings: unknown[] } {
    // Every row must list the same columns, so a caller cannot silently drop a
    // value in a batch insert.
    const columns = rows.length === 0 ? [] : Object.keys(rows[0] as Record<string, unknown>)

    // `insert into t () values ()` is a syntax error in sqlite and postgres, so
    // a row with no columns has to become an explicit defaults insert.
    if (columns.length === 0) {
      return { sql: this.compileInsertDefaults(table), bindings: [] }
    }
    const bindings: unknown[] = []

    const tuples = rows.map((row) => {
      const values = columns.map((column) => {
        const value = row[column]
        if (isExpression(value)) return value.value
        bindings.push(value ?? null)
        return this.parameter(bindings.length)
      })
      return `(${values.join(', ')})`
    })

    const sql = `insert into ${this.wrapTable(table)} (${this.columnize(columns)}) values ${tuples.join(', ')}`

    return { sql, bindings }
  }

  /** `insert into t default values` — MySQL spells this differently. */
  protected compileInsertDefaults(table: string): string {
    return `insert into ${this.wrapTable(table)} default values`
  }

  compileUpdate(
    query: QueryComponents,
    values: Record<string, unknown>
  ): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = []

    const assignments = Object.entries(values)
      .map(([column, value]) => {
        if (isExpression(value)) return `${this.wrap(column)} = ${value.value}`
        bindings.push(value ?? null)
        return `${this.wrap(column)} = ${this.parameter(bindings.length)}`
      })
      .join(', ')

    const parts = [`update ${this.wrapTable(query.from)} set ${assignments}`]

    const wheres = this.compileWheres(query.wheres, bindings)
    if (wheres) parts.push(`where ${wheres}`)

    return { sql: parts.join(' '), bindings }
  }

  compileDelete(query: QueryComponents): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = []
    const parts = [`delete from ${this.wrapTable(query.from)}`]

    const wheres = this.compileWheres(query.wheres, bindings)
    if (wheres) parts.push(`where ${wheres}`)

    return { sql: parts.join(' '), bindings }
  }

  compileTruncate(table: string): string[] {
    return [`truncate table ${this.wrapTable(table)}`]
  }

  compileExists(query: QueryComponents): { sql: string; bindings: unknown[] } {
    const select = this.compileSelect(query)

    return { sql: `select exists(${select.sql}) as "exists"`, bindings: select.bindings }
  }

  /** `insert ... on conflict do update` — syntax differs sharply per dialect. */
  abstract compileUpsert(
    table: string,
    rows: Array<Record<string, unknown>>,
    uniqueBy: string[],
    update: string[]
  ): { sql: string; bindings: unknown[] }

  abstract compileInsertOrIgnore(
    table: string,
    rows: Array<Record<string, unknown>>
  ): { sql: string; bindings: unknown[] }

  /** Appended to an insert when the driver can return the new row. */
  supportsReturning(): boolean {
    return false
  }
}
