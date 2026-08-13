import { Collection } from '@elysian/support'
import type { Connection, Row } from '../connection/connection.ts'
import { Expression, isExpression, raw } from './expression.ts'
import type {
  AggregateClause,
  Boolean_,
  JoinClause,
  QueryComponents,
  WhereClause
} from './types.ts'
import { cloneQuery, emptyQuery } from './types.ts'

type Operator = string
type Value = unknown

/**
 * Fluent query builder.
 *
 * It records a `QueryComponents` description and hands it to the connection's
 * grammar, so one builder serves every dialect and `toSql()` needs no database.
 */
export class QueryBuilder<T extends Row = Row> {
  private query: QueryComponents

  constructor(
    readonly connection: Connection,
    table = ''
  ) {
    this.query = emptyQuery(table)
  }

  // ------------------------------------------------------------------ select

  from(table: string): this {
    this.query.from = table
    return this
  }

  select(...columns: Array<string | Expression>): this {
    this.query.columns = columns.flat()
    return this
  }

  addSelect(...columns: Array<string | Expression>): this {
    this.query.columns.push(...columns.flat())
    return this
  }

  selectRaw(sql: string): this {
    this.query.columns.push(new Expression(sql))
    return this
  }

  distinct(): this {
    this.query.distinct = true
    return this
  }

  // ------------------------------------------------------------------- joins

  join(table: string, first: string, operator: Operator, second: string): this {
    return this.addJoin('inner', table, first, operator, second)
  }

  leftJoin(table: string, first: string, operator: Operator, second: string): this {
    return this.addJoin('left', table, first, operator, second)
  }

  rightJoin(table: string, first: string, operator: Operator, second: string): this {
    return this.addJoin('right', table, first, operator, second)
  }

  crossJoin(table: string): this {
    this.query.joins.push({ type: 'cross', table, wheres: [] })
    return this
  }

  /**
   * Join a subquery — `joinSub`.
   *
   * The subquery is compiled here rather than kept as a builder, because the
   * grammar assembles one flat statement: what a join needs is the SQL text and
   * the bindings, in the position they will be read.
   */
  joinSub(
    query: QueryBuilder<Row> | { toSql(): string; getBindings(): unknown[] },
    alias: string,
    first: string,
    operator: Operator,
    second: string,
    type: JoinClause['type'] = 'inner'
  ): this {
    this.query.joins.push({
      type,
      table: raw(`(${query.toSql()}) as ${this.connection.grammar.wrapTable(alias)}`),
      wheres: [{ type: 'column', first, operator, second, boolean: 'and' }],
      bindings: query.getBindings()
    })

    return this
  }

  leftJoinSub(
    query: QueryBuilder<Row> | { toSql(): string; getBindings(): unknown[] },
    alias: string,
    first: string,
    operator: Operator,
    second: string
  ): this {
    return this.joinSub(query, alias, first, operator, second, 'left')
  }

  private addJoin(
    type: JoinClause['type'],
    table: string,
    first: string,
    operator: Operator,
    second: string
  ): this {
    this.query.joins.push({
      type,
      table,
      wheres: [{ type: 'column', first, operator, second, boolean: 'and' }]
    })

    return this
  }

  // ------------------------------------------------------------------ wheres

  /**
   * The column's JSON value contains this — `whereJsonContains('meta->tags', 'a')`.
   *
   * Containment, not equality: on an array it asks "is this a member", which is
   * the question `where('meta->tags', ...)` cannot express.
   */
  whereJsonContains(column: string, value: unknown, not = false): this {
    this.query.wheres.push({ type: 'jsonContains', column, value, not, boolean: 'and' })
    return this
  }

  whereJsonDoesntContain(column: string, value: unknown): this {
    return this.whereJsonContains(column, value, true)
  }

  /**
   * Full-text search — `whereFullText(['title', 'body'], 'needle')`.
   *
   * MySQL wants a FULLTEXT index and Postgres a tsvector; each grammar emits its
   * own form, and SQLite refuses with an explanation rather than pretending with
   * a LIKE.
   */
  whereFullText(columns: string | string[], value: string): this {
    this.query.wheres.push({
      type: 'fullText',
      columns: Array.isArray(columns) ? columns : [columns],
      value,
      boolean: 'and'
    })
    return this
  }

  where(column: string, operator: Operator, value?: Value): this
  where(column: string, value: Value): this
  where(callback: (query: QueryBuilder<T>) => void): this
  where(
    column: string | ((query: QueryBuilder<T>) => void),
    operatorOrValue?: Operator | Value,
    value?: Value
  ): this {
    if (typeof column === 'function') return this.whereNested(column, 'and')

    const [operator, resolved] = this.normaliseOperator(operatorOrValue, value, arguments.length)

    if (resolved === null) return this.whereNull(column, 'and', operator === '!=')

    this.query.wheres.push({ type: 'basic', column, operator, value: resolved, boolean: 'and' })
    return this
  }

  orWhere(column: string, operator: Operator, value?: Value): this
  orWhere(column: string, value: Value): this
  orWhere(callback: (query: QueryBuilder<T>) => void): this
  orWhere(
    column: string | ((query: QueryBuilder<T>) => void),
    operatorOrValue?: Operator | Value,
    value?: Value
  ): this {
    if (typeof column === 'function') return this.whereNested(column, 'or')

    const [operator, resolved] = this.normaliseOperator(operatorOrValue, value, arguments.length)

    if (resolved === null) return this.whereNull(column, 'or', operator === '!=')

    this.query.wheres.push({ type: 'basic', column, operator, value: resolved, boolean: 'or' })
    return this
  }

  /**
   * Accept both `where('a', 1)` and `where('a', '>', 1)`.
   *
   * The argument count matters: `where('a', undefined)` is a comparison against
   * undefined, while `where('a', '>')` would be a missing value — treating them
   * the same is how "silently matched everything" bugs happen.
   */
  private normaliseOperator(
    operatorOrValue: Operator | Value,
    value: Value,
    argumentCount: number
  ): [string, Value] {
    if (argumentCount < 3) {
      return ['=', operatorOrValue]
    }

    const operator = String(operatorOrValue)

    if (!this.connection.grammar.isValidOperator(operator)) {
      throw new Error(`Unsupported operator [${operator}] in a where clause.`)
    }

    return [operator, value]
  }

  whereNot(column: string, value: Value): this {
    return this.where(column, '!=', value)
  }

  whereColumn(first: string, operator: Operator, second: string): this {
    this.query.wheres.push({ type: 'column', first, operator, second, boolean: 'and' })
    return this
  }

  whereNull(column: string, boolean: Boolean_ = 'and', not = false): this {
    this.query.wheres.push({ type: 'null', column, not, boolean })
    return this
  }

  whereNotNull(column: string): this {
    return this.whereNull(column, 'and', true)
  }

  whereIn(column: string, values: Value[]): this {
    this.query.wheres.push({ type: 'in', column, values, not: false, boolean: 'and' })
    return this
  }

  whereNotIn(column: string, values: Value[]): this {
    this.query.wheres.push({ type: 'in', column, values, not: true, boolean: 'and' })
    return this
  }

  whereBetween(column: string, values: [Value, Value]): this {
    this.query.wheres.push({ type: 'between', column, values, not: false, boolean: 'and' })
    return this
  }

  whereNotBetween(column: string, values: [Value, Value]): this {
    this.query.wheres.push({ type: 'between', column, values, not: true, boolean: 'and' })
    return this
  }

  whereLike(column: string, value: string): this {
    return this.where(column, 'like', value)
  }

  whereRaw(sql: string, bindings: unknown[] = []): this {
    this.query.wheres.push({ type: 'raw', sql, bindings, boolean: 'and' })
    return this
  }

  whereExists(callback: (query: QueryBuilder) => void, not = false): this {
    const nested = new QueryBuilder(this.connection)
    callback(nested)

    this.query.wheres.push({ type: 'exists', query: nested.components, not, boolean: 'and' })
    return this
  }

  whereNotExists(callback: (query: QueryBuilder) => void): this {
    return this.whereExists(callback, true)
  }

  private whereNested(callback: (query: QueryBuilder<T>) => void, boolean: Boolean_): this {
    const nested = new QueryBuilder<T>(this.connection, this.query.from)
    callback(nested)

    if (nested.components.wheres.length > 0) {
      this.query.wheres.push({ type: 'nested', wheres: nested.components.wheres, boolean })
    }

    return this
  }

  // ------------------------------------------------------- grouping, ordering

  groupBy(...columns: Array<string | Expression>): this {
    this.query.groups.push(...columns.flat())
    return this
  }

  having(column: string, operator: Operator, value: Value): this {
    this.query.havings.push({ type: 'basic', column, operator, value, boolean: 'and' })
    return this
  }

  havingRaw(sql: string, bindings: unknown[] = []): this {
    this.query.havings.push({ type: 'raw', sql, bindings, boolean: 'and' })
    return this
  }

  orderBy(column: string | Expression, direction: 'asc' | 'desc' = 'asc'): this {
    this.query.orders.push({ column, direction })
    return this
  }

  orderByDesc(column: string): this {
    return this.orderBy(column, 'desc')
  }

  latest(column = 'created_at'): this {
    return this.orderBy(column, 'desc')
  }

  oldest(column = 'created_at'): this {
    return this.orderBy(column, 'asc')
  }

  /**
   * Drop every order, optionally replacing it with one.
   *
   * Laravel's signature, and the replacement form is what key-based walking needs:
   * paging by key requires the key's order, and leaving a caller's `orderBy` in
   * place would page in one order while filtering in another.
   */
  reorder(column?: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.query.orders = []

    return column === undefined ? this : this.orderBy(column, direction)
  }

  limit(count: number): this {
    this.query.limit = count
    return this
  }

  offset(count: number): this {
    this.query.offset = count
    return this
  }

  take(count: number): this {
    return this.limit(count)
  }

  skip(count: number): this {
    return this.offset(count)
  }

  forPage(page: number, perPage = 15): this {
    return this.offset((Math.max(1, page) - 1) * perPage).limit(perPage)
  }

  lockForUpdate(): this {
    this.query.lock = 'update'
    return this
  }

  sharedLock(): this {
    this.query.lock = 'share'
    return this
  }

  // ------------------------------------------------------------- conditional

  when(condition: unknown, callback: (query: this) => void): this {
    if (condition) callback(this)
    return this
  }

  unless(condition: unknown, callback: (query: this) => void): this {
    if (!condition) callback(this)
    return this
  }

  tap(callback: (query: this) => void): this {
    callback(this)
    return this
  }

  clone(): QueryBuilder<T> {
    const copy = new QueryBuilder<T>(this.connection, this.query.from)
    copy.query = cloneQuery(this.query)
    return copy
  }

  // -------------------------------------------------------------- inspection

  get components(): QueryComponents {
    return this.query
  }

  /** The connection this query runs on, needed to build correlated subqueries. */
  get connectionRef(): Connection {
    return this.connection
  }

  /** Change the table without rebuilding the query. */
  fromTable(table: string): this {
    this.query.from = table
    return this
  }

  toSql(): string {
    return this.connection.grammar.compileSelect(this.query).sql
  }

  getBindings(): unknown[] {
    return this.connection.grammar.compileSelect(this.query).bindings
  }

  // ----------------------------------------------------------------- reading

  async get(): Promise<Collection<T>> {
    const { sql, bindings } = this.connection.grammar.compileSelect(this.query)

    return new Collection(await this.connection.select<T>(sql, bindings))
  }

  async first(): Promise<T | undefined> {
    const rows = await this.clone().limit(1).get()

    return rows.first()
  }

  async find(id: Value, column = 'id'): Promise<T | undefined> {
    return this.clone().where(column, '=', id).first()
  }

  async value<V = unknown>(column: string): Promise<V | undefined> {
    const row = await this.clone().select(column).first()

    return row === undefined ? undefined : (row[column] as V)
  }

  async pluck<V = unknown>(column: string): Promise<Collection<V>> {
    const rows = await this.clone().select(column).get()

    return rows.map((row) => row[column] as V)
  }

  async exists(): Promise<boolean> {
    const { sql, bindings } = this.connection.grammar.compileExists(this.query)
    const rows = await this.connection.select<Record<string, unknown>>(sql, bindings)
    const value = Object.values(rows[0] ?? {})[0]

    return value === true || value === 1 || value === '1'
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists())
  }

  /** Walk the table in pages, so a large table never lands in memory at once. */
  async chunk(
    size: number,
    callback: (rows: Collection<T>, page: number) => Promise<unknown> | unknown
  ): Promise<void> {
    let page = 1

    while (true) {
      const rows = await this.clone().forPage(page, size).get()
      if (rows.isEmpty()) return

      if ((await callback(rows, page)) === false) return
      if (rows.count() < size) return

      page += 1
    }
  }

  // -------------------------------------------------------------- aggregates

  async count(column = '*'): Promise<number> {
    return Number((await this.aggregate('count', column)) ?? 0)
  }

  async max<V = number>(column: string): Promise<V | null> {
    return (await this.aggregate('max', column)) as V | null
  }

  async min<V = number>(column: string): Promise<V | null> {
    return (await this.aggregate('min', column)) as V | null
  }

  async sum(column: string): Promise<number> {
    return Number((await this.aggregate('sum', column)) ?? 0)
  }

  async avg(column: string): Promise<number | null> {
    const value = await this.aggregate('avg', column)

    return value === null || value === undefined ? null : Number(value)
  }

  private async aggregate(fn: AggregateClause['fn'], column: string): Promise<unknown> {
    const query = this.clone()
    query.query.aggregate = { fn, column }
    query.query.columns = []
    query.query.orders = []

    const { sql, bindings } = this.connection.grammar.compileSelect(query.query)
    const rows = await this.connection.select<{ aggregate: unknown }>(sql, bindings)

    return rows[0]?.aggregate ?? null
  }

  // ----------------------------------------------------------------- writing

  async insert(values: Record<string, unknown> | Array<Record<string, unknown>>): Promise<number> {
    const rows = Array.isArray(values) ? values : [values]
    if (rows.length === 0) return 0

    const { sql, bindings } = this.connection.grammar.compileInsert(this.query.from, rows)

    return this.connection.affectingStatement(sql, bindings)
  }

  async insertOrIgnore(
    values: Record<string, unknown> | Array<Record<string, unknown>>
  ): Promise<number> {
    const rows = Array.isArray(values) ? values : [values]
    if (rows.length === 0) return 0

    const { sql, bindings } = this.connection.grammar.compileInsertOrIgnore(this.query.from, rows)

    return this.connection.affectingStatement(sql, bindings)
  }

  /** Insert one row and return it, using RETURNING where the dialect allows. */
  async insertGetId(values: Record<string, unknown>, idColumn = 'id'): Promise<unknown> {
    const { sql, bindings } = this.connection.grammar.compileInsert(this.query.from, [values])

    if (this.connection.grammar.supportsReturning()) {
      const rows = await this.connection.select<Record<string, unknown>>(
        `${sql} returning ${this.connection.grammar.wrap(idColumn)}`,
        bindings
      )

      return rows[0]?.[idColumn]
    }

    await this.connection.affectingStatement(sql, bindings)
    const rows = await this.connection.select<Record<string, unknown>>(
      `select last_insert_id() as ${this.connection.grammar.wrap(idColumn)}`
    )

    return rows[0]?.[idColumn]
  }

  async upsert(
    values: Record<string, unknown> | Array<Record<string, unknown>>,
    uniqueBy: string[],
    update?: string[]
  ): Promise<number> {
    const rows = Array.isArray(values) ? values : [values]
    if (rows.length === 0) return 0

    const columns =
      update ??
      Object.keys(rows[0] as Record<string, unknown>).filter((column) => !uniqueBy.includes(column))

    const { sql, bindings } = this.connection.grammar.compileUpsert(
      this.query.from,
      rows,
      uniqueBy,
      columns
    )

    return this.connection.affectingStatement(sql, bindings)
  }

  async update(values: Record<string, unknown>): Promise<number> {
    const { sql, bindings } = this.connection.grammar.compileUpdate(this.query, values)

    return this.connection.affectingStatement(sql, bindings)
  }

  async updateOrInsert(
    attributes: Record<string, unknown>,
    values: Record<string, unknown> = {}
  ): Promise<boolean> {
    const query = this.clone()
    for (const [column, value] of Object.entries(attributes)) query.where(column, '=', value)

    if (!(await query.exists())) {
      await this.clone().insert({ ...attributes, ...values })
      return true
    }

    if (Object.keys(values).length > 0) await query.update(values)
    return false
  }

  async increment(
    column: string,
    amount = 1,
    extra: Record<string, unknown> = {}
  ): Promise<number> {
    const wrapped = this.connection.grammar.wrap(column)

    return this.update({ ...extra, [column]: new Expression(`${wrapped} + ${Number(amount)}`) })
  }

  async decrement(
    column: string,
    amount = 1,
    extra: Record<string, unknown> = {}
  ): Promise<number> {
    const wrapped = this.connection.grammar.wrap(column)

    return this.update({ ...extra, [column]: new Expression(`${wrapped} - ${Number(amount)}`) })
  }

  async delete(id?: Value): Promise<number> {
    const query = id === undefined ? this : this.clone().where('id', '=', id)
    const { sql, bindings } = this.connection.grammar.compileDelete(query.components)

    return this.connection.affectingStatement(sql, bindings)
  }

  async truncate(): Promise<void> {
    for (const sql of this.connection.grammar.compileTruncate(this.query.from)) {
      await this.connection.statement(sql)
    }
  }
}

export { isExpression }
