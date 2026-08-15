import { Collection } from '@elysian/support'
import type { Connection, Row } from '../connection/connection.ts'
import { Expression, isExpression, raw } from './expression.ts'
import type {
  AggregateClause,
  Boolean_,
  JoinClause,
  QueryComponents,
  VectorMetric,
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
   * How many elements a JSON array holds — `whereJsonLength('meta->tags', '>', 2)`.
   *
   * Two arguments mean equality, as everywhere else in the builder, so
   * `whereJsonLength('meta->tags', 0)` finds the documents with an empty array.
   *
   * This is an array length, not a key count, and the engines disagree about
   * what a non-array should answer: MySQL says 1, SQLite says null, Postgres
   * raises. None of them is wrong — a key that holds different shapes in
   * different rows is the thing to fix.
   */
  /**
   * Nearest by vector distance — `orderByVector('embedding', query)`.
   *
   * The ordering half of a similarity search: rows come back nearest first, and
   * an index on the same operator turns it into a scan rather than a sort.
   * Requires Postgres with pgvector; other grammars refuse rather than emitting
   * SQL that would quietly order by something else.
   */
  orderByVector(column: string, vector: number[], metric: VectorMetric = 'cosine'): this {
    this.query.orders.push({ vector: { column, metric, values: vector } })

    return this
  }

  /**
   * Filter by distance — `whereVectorDistance('embedding', v, '<', 0.25)`.
   *
   * Ordering finds the nearest rows; this asks "near enough", which is the
   * question a recommendation or a duplicate check actually has. The nearest row
   * to a nonsense query is still a row, and only a threshold can say it was not
   * a match.
   */
  whereVectorDistance(
    column: string,
    vector: number[],
    operator: string,
    value: number,
    metric: VectorMetric = 'cosine'
  ): this {
    this.query.wheres.push({
      type: 'vectorDistance',
      column,
      metric,
      vector,
      operator,
      value,
      boolean: 'and'
    })

    return this
  }

  whereJsonLength(column: string, operator: string | number, value?: unknown): this {
    const resolved = value === undefined ? '=' : String(operator)
    const target = value === undefined ? operator : value

    this.query.wheres.push({
      type: 'jsonLength',
      column,
      operator: resolved,
      value: target,
      boolean: 'and'
    })

    return this
  }

  orWhereJsonLength(column: string, operator: string | number, value?: unknown): this {
    this.whereJsonLength(column, operator, value)

    const last = this.query.wheres[this.query.wheres.length - 1]
    if (last) last.boolean = 'or'

    return this
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

  /** Laravel's spelling of the same aggregate. */
  average(column: string): Promise<number | null> {
    return this.avg(column)
  }

  /**
   * Every value joined into one string.
   *
   * The join happens here rather than in SQL: `group_concat` is SQLite's,
   * `GROUP_CONCAT` MySQL's and `string_agg` Postgres's, with three different
   * separator syntaxes, and none of them is worth a grammar branch for something
   * a caller does once at the end.
   */
  async implode(column: string, separator = ''): Promise<string> {
    return (await this.pluck(column)).map((value) => String(value)).join(separator)
  }

  // -------------------------------------------------------------- ordering

  /**
   * Shuffle the rows — `RANDOM()`, or `RAND()` on MySQL.
   *
   * The function name is the only difference, and getting it wrong is a syntax
   * error rather than a wrong answer, so it is asked of the dialect rather than
   * assumed.
   */
  inRandomOrder(): this {
    const dialect = this.connection.grammar.dialect
    const fn = dialect === 'mysql' ? 'RAND()' : 'RANDOM()'

    this.query.orders.push({ column: raw(fn) })

    return this
  }

  /**
   * Order by a list of values, in the order they were given.
   *
   * For "show these ids, in this sequence" — a search engine's ranking, or a
   * hand-curated list. Compiled as a `case` rather than sorted afterwards,
   * because the ordering has to survive `limit`.
   */
  inOrderOf(column: string, values: Value[]): this {
    if (values.length === 0) return this

    const wrapped = this.connection.grammar.wrap(column)
    const cases = values
      .map((value, index) => `when ${wrapped} = ${literal(value)} then ${index}`)
      .join(' ')

    this.query.orders.push({ column: raw(`case ${cases} else ${values.length} end`) })

    return this
  }

  groupByRaw(sql: string): this {
    this.query.groups.push(raw(sql))

    return this
  }

  // --------------------------------------------------------------- having

  havingBetween(column: string, values: [Value, Value]): this {
    this.query.havings.push({ type: 'between', column, values, not: false, boolean: 'and' })

    return this
  }

  havingNull(column: string): this {
    this.query.havings.push({ type: 'null', column, not: false, boolean: 'and' })

    return this
  }

  havingNotNull(column: string): this {
    this.query.havings.push({ type: 'null', column, not: true, boolean: 'and' })

    return this
  }

  // ------------------------------------------------------------ paginating

  /**
   * The page after a known id — Laravel's `forPageAfterId`.
   *
   * Cheaper and steadier than `offset`: the database seeks the index rather than
   * counting past rows it will discard, and a row inserted mid-walk cannot shift
   * the window. Any existing order on the column is dropped, because two orders
   * on one column is not a thing.
   */
  forPageAfterId(perPage = 15, lastId: Value = 0, column = 'id'): this {
    this.query.orders = this.query.orders.filter(
      (order) => isExpression(order.column) || order.column !== column
    )

    if (lastId === null) this.whereNotNull(column)
    else this.where(column, '>', lastId)

    return this.orderBy(column).limit(perPage)
  }

  /**
   * Walk the whole result without holding it in memory.
   *
   * Pages by key rather than offset, for the reason `chunkById` exists: an offset
   * walk silently skips rows when anything is deleted while it runs.
   */
  async *cursor(column = 'id', size = 500): AsyncGenerator<Row> {
    let last: Value = null
    let first = true

    while (true) {
      const page = this.clone()
      if (!first) page.where(column, '>', last)

      const rows = await page.orderBy(column).limit(size).get()
      if (rows.count() === 0) return

      for (const row of rows) yield row

      last = (rows.last() as Row)[column] as Value
      first = false
    }
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

  /**
   * Several counters in one statement — Laravel's `incrementEach`.
   *
   * One `update` rather than one per column: two updates to the same row race
   * each other, and the second overwrites what the first read.
   */
  async incrementEach(
    columns: Record<string, number>,
    extra: Record<string, unknown> = {}
  ): Promise<number> {
    const changes: Record<string, unknown> = { ...extra }

    for (const [column, amount] of Object.entries(columns)) {
      if (!Number.isFinite(amount)) {
        throw new Error(`incrementEach() needs a number for [${column}], saw ${String(amount)}.`)
      }

      changes[column] = new Expression(
        `${this.connection.grammar.wrap(column)} + ${Number(amount)}`
      )
    }

    return this.update(changes)
  }

  async decrementEach(
    columns: Record<string, number>,
    extra: Record<string, unknown> = {}
  ): Promise<number> {
    return this.incrementEach(
      Object.fromEntries(Object.entries(columns).map(([column, amount]) => [column, -amount])),
      extra
    )
  }

  /**
   * Insert the rows another query selects — `insert into … select …`.
   *
   * The rows never leave the database, which is the point: copying a million rows
   * through this process to write them back is a round trip per batch and a lot
   * of memory for data that was already where it needed to be.
   */
  async insertUsing(
    columns: string[],
    query: QueryBuilder<Row> | { toSql(): string; getBindings(): unknown[] }
  ): Promise<number> {
    const table = this.connection.grammar.wrapTable(this.query.from)
    const wrapped = columns.map((column) => this.connection.grammar.wrap(column)).join(', ')

    // `affectingStatement`, not `statement`: the latter is for DDL and reports
    // nothing, so this used to answer 0 while inserting the rows perfectly well.
    return this.connection.affectingStatement(
      `insert into ${table} (${wrapped}) ${query.toSql()}`,
      query.getBindings()
    )
  }

  /**
   * Select from a subquery — `from (select …) as alias`.
   *
   * For anything that has to aggregate and then filter on the aggregate, which a
   * `having` cannot always express.
   */
  fromSub(
    query: QueryBuilder<Row> | { toSql(): string; getBindings(): unknown[] },
    alias: string
  ): this {
    this.query.fromRaw = raw(`(${query.toSql()}) as ${this.connection.grammar.wrapTable(alias)}`)
    this.query.fromBindings = [...query.getBindings()]

    return this
  }

  /** A cartesian join against a subquery. */
  crossJoinSub(
    query: QueryBuilder<Row> | { toSql(): string; getBindings(): unknown[] },
    alias: string
  ): this {
    this.query.joins.push({
      type: 'cross',
      table: raw(`(${query.toSql()}) as ${this.connection.grammar.wrapTable(alias)}`),
      wheres: [],
      bindings: query.getBindings()
    })

    return this
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

/**
 * A value inlined into SQL, for the `case` that `inOrderOf` builds.
 *
 * Ordinarily everything is bound, and this is the exception: an `order by` cannot
 * carry bindings in every dialect, and the values here are ids the caller already
 * had. Numbers pass through; anything else is quoted with its own quotes doubled,
 * which is the escaping every one of these dialects agrees on.
 */
function literal(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value === null || value === undefined) return 'null'

  return `'${String(value).replace(/'/g, "''")}'`
}
