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

    // `meta->theme` reaches into a JSON column. Dialect-specific, so each grammar
    // says how — and an engine with no JSON support says so instead of quoting the
    // arrow as if it were part of a column name.
    if (value.includes('->')) return this.wrapJsonSelector(value)

    return value
      .split('.')
      .map((segment) => this.wrapValue(segment))
      .join('.')
  }

  /** `meta->a->b` split into the real column and the path below it. */
  protected jsonPathParts(value: string): { column: string; path: string[] } {
    const [column, ...path] = value.split('->')

    return { column: (column as string).trim(), path: path.map((segment) => segment.trim()) }
  }

  /** `'$."a"."b"'` — the SQL/JSON path both SQLite and MySQL address by. */
  protected jsonPath(path: string[]): string {
    return `'$${path.map((segment) => `."${segment.replaceAll('"', '""')}"`).join('')}'`
  }

  protected wrapJsonSelector(_value: string): string {
    throw new Error(`This database engine does not support JSON paths (\`column->key\`).`)
  }

  /** A vector as the driver should bind it. Only Postgres has an opinion. */
  protected vectorLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`
  }

  /** The distance expression, when the engine has vectors at all. */
  protected compileVectorDistance(_column: string, _metric: string, _value: string): string {
    throw new Error(
      'This database engine has no vector distance operators. Postgres with pgvector does.'
    )
  }

  /** `json_length(...) > ?`, spelled differently by every engine. */
  protected compileJsonLength(_column: string, _operator: string, _value: string): string {
    throw new Error('This database engine does not support whereJsonLength().')
  }

  /**
   * One `set` assignment that writes *inside* a JSON document.
   *
   * Every path aimed at the same column arrives together, and that grouping is
   * not tidiness: `set meta = …, meta = …` is legal SQL in which the second
   * assignment wins, so writing two keys of one document as two assignments
   * silently drops the first.
   *
   * Returning undefined means the engine cannot do it, which is the base case
   * here — a driver with no JSON support says so rather than emitting something
   * that parses and does the wrong thing.
   */
  protected compileJsonUpdate(
    _column: string,
    _writes: Array<{ path: string[]; value: unknown }>,
    _bindings: unknown[]
  ): string | undefined {
    return undefined
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

    parts.push(`from ${query.fromRaw ? query.fromRaw.value : this.wrapTable(query.from)}`)

    // Before the joins, because the subquery is written before them.
    if (query.fromBindings) bindings.push(...query.fromBindings)

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
        .map((order) => {
          if (order.vector) {
            bindings.push(this.vectorLiteral(order.vector.values))

            // Ascending always: every distance operator returns "smaller is
            // nearer", which is also what lets an index answer the ordering.
            return `${this.compileVectorDistance(order.vector.column, order.vector.metric, this.parameter(bindings.length))} asc`
          }

          if (order.column === undefined) return ''

          return isExpression(order.column)
            ? order.column.value
            : `${this.wrap(order.column)} ${order.direction ?? 'asc'}`
        })
        .filter((clause) => clause !== '')
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

  protected compileJsonContains(
    _column: string,
    _value: unknown,
    _not: boolean,
    _bindings: unknown[]
  ): string {
    throw new Error('This database engine does not support JSON contains operations.')
  }

  protected compileFullText(_columns: string[], _value: string, _bindings: unknown[]): string {
    throw new Error('This database engine does not support full-text search.')
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

      case 'jsonContains': {
        return this.compileJsonContains(where.column, where.value, where.not, bindings)
      }

      case 'vectorDistance': {
        bindings.push(this.vectorLiteral(where.vector))
        const distance = this.compileVectorDistance(
          where.column,
          where.metric,
          this.parameter(bindings.length)
        )

        bindings.push(where.value)

        return `${distance} ${where.operator} ${this.parameter(bindings.length)}`
      }

      case 'jsonLength': {
        bindings.push(where.value)

        return this.compileJsonLength(where.column, where.operator, this.parameter(bindings.length))
      }

      case 'fullText': {
        return this.compileFullText(where.columns, where.value, bindings)
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

    /**
     * JSON writes are collected per column before anything is compiled.
     *
     * `meta->theme` is a write *into* the document, not a column with an arrow in
     * its name, and two of them aimed at one column have to become a single
     * assignment — see `compileJsonUpdate`.
     */
    const json = new Map<string, Array<{ path: string[]; value: unknown }>>()
    const plain: string[] = []

    for (const [column, value] of Object.entries(values)) {
      if (isExpression(value)) {
        plain.push(`${this.wrap(column)} = ${value.value}`)

        continue
      }

      if (column.includes('->')) {
        const { column: field, path } = this.jsonPathParts(column)
        const writes = json.get(field) ?? []

        writes.push({ path, value })
        json.set(field, writes)

        continue
      }

      bindings.push(value ?? null)
      plain.push(`${this.wrap(column)} = ${this.parameter(bindings.length)}`)
    }

    for (const [column, writes] of json) {
      const compiled = this.compileJsonUpdate(column, writes, bindings)

      if (compiled === undefined) {
        throw new Error(
          `This database engine does not support updating a JSON path (\`${column}->${writes[0]?.path.join('->')}\`).`
        )
      }

      plain.push(compiled)
    }

    const assignments = plain.join(', ')

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
