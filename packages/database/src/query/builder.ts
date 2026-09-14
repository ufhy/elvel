import {
  Collection,
  Macroable,
  Paginator,
  type PaginatorOptions,
  Paginators,
  SimplePaginator
} from '@elvel/support'
import type { Connection, Row } from '../connection/connection.ts'
import { Expression, isExpression, raw } from './expression.ts'
import type {
  AggregateClause,
  Boolean_,
  JoinClause,
  QueryComponents,
  VectorMetric
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
/** A thing that can be embedded as a subquery: a builder, or anything shaped like one. */
export type Subqueryable =
  | { compile(): { sql: string; bindings: unknown[] } }
  | { toSql(): string; getBindings(): unknown[] }

/**
 * One compilation, whichever shape arrived.
 *
 * `joinSub` and friends accept anything with `toSql`/`getBindings` so a caller can
 * pass a hand-rolled query object. A real builder is compiled once through
 * `compile()`; the duck-typed form still costs two passes, because two methods is
 * all it offers.
 */
function compileSub(query: Subqueryable): { sql: string; bindings: unknown[] } {
  if ('compile' in query) return query.compile()

  return { sql: query.toSql(), bindings: query.getBindings() }
}

export class QueryBuilder<T extends Row = Row> extends Macroable {
  private query: QueryComponents
  private readonly beforeCallbacks: Array<(query: QueryBuilder<T>) => void> = []
  private readonly afterCallbacks: Array<(rows: Collection<T>) => Collection<T> | undefined> = []

  constructor(
    readonly connection: Connection,
    table = ''
  ) {
    super()
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

  /**
   * A subquery as one column — `selectSub(latest, 'last_order_at')`.
   *
   * Its bindings are kept apart from the wheres': SQL reads the select list
   * first, so a placeholder there is filled before any that follow it, and one
   * flat list silently pairs values with the wrong question marks.
   */
  selectSub(query: QueryBuilder<Row> | Subqueryable, alias: string): this {
    const sub = compileSub(query)

    this.query.columns.push(raw(`(${sub.sql}) as ${this.connection.grammar.wrapTable(alias)}`))
    this.query.columnBindings = [...(this.query.columnBindings ?? []), ...sub.bindings]

    return this
  }

  /**
   * `from (…)` written out — for a table-valued function or a VALUES list.
   *
   * The SQL is emitted verbatim, so it is the caller's to trust. `fromSub` is
   * the one to reach for when a query builder can say it.
   */
  fromRaw(sql: string, bindings: unknown[] = []): this {
    this.query.fromRaw = raw(sql)
    this.query.fromBindings = [...bindings]

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

  /**
   * A join whose subquery can see the row it is joined to.
   *
   * The three-most-recent-per-user query, without a window function: the
   * subquery takes its own `limit` per outer row, which an ordinary join cannot
   * express. SQLite has no `lateral` and says so.
   */
  joinLateral(
    query: QueryBuilder<Row> | Subqueryable,
    alias: string,
    type: 'inner' | 'left' = 'inner'
  ): this {
    const sub = compileSub(query)

    this.query.joins.push({
      type,
      lateral: true,
      table: raw(`(${sub.sql}) as ${this.connection.grammar.wrapTable(alias)}`),
      wheres: [],
      bindings: sub.bindings
    })

    return this
  }

  leftJoinLateral(query: QueryBuilder<Row> | Subqueryable, alias: string): this {
    return this.joinLateral(query, alias, 'left')
  }

  rightJoinSub(
    query: QueryBuilder<Row> | Subqueryable,
    alias: string,
    first: string,
    operator: Operator,
    second: string
  ): this {
    return this.joinSub(query, alias, first, operator, second, 'right')
  }

  /**
   * Join on a value rather than a column — `joinWhere('roles', 'roles.level', '>', 3)`.
   *
   * `join()` compares two columns, so a constant in the `on` clause had to be
   * either a `where` — which changes what a left join returns — or raw SQL.
   */
  joinWhere(table: string, first: string, operator: Operator, value: Value): this {
    return this.addJoinWhere('inner', table, first, operator, value)
  }

  leftJoinWhere(table: string, first: string, operator: Operator, value: Value): this {
    return this.addJoinWhere('left', table, first, operator, value)
  }

  rightJoinWhere(table: string, first: string, operator: Operator, value: Value): this {
    return this.addJoinWhere('right', table, first, operator, value)
  }

  /** MySQL's `straight_join` — read the left table first, whatever the planner thinks. */
  straightJoin(table: string, first: string, operator: Operator, second: string): this {
    return this.addJoin('straight', table, first, operator, second)
  }

  private addJoinWhere(
    type: JoinClause['type'],
    table: string,
    first: string,
    operator: Operator,
    value: Value
  ): this {
    this.query.joins.push({
      type,
      table,
      wheres: [{ type: 'basic', column: first, operator: String(operator), value, boolean: 'and' }]
    })

    return this
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
    query: QueryBuilder<Row> | Subqueryable,
    alias: string,
    first: string,
    operator: Operator,
    second: string,
    type: JoinClause['type'] = 'inner'
  ): this {
    const sub = compileSub(query)

    this.query.joins.push({
      type,
      table: raw(`(${sub.sql}) as ${this.connection.grammar.wrapTable(alias)}`),
      wheres: [{ type: 'column', first, operator, second, boolean: 'and' }],
      bindings: sub.bindings
    })

    return this
  }

  leftJoinSub(
    query: QueryBuilder<Row> | Subqueryable,
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

  /**
   * The `or` twins.
   *
   * Sixteen of these were absent while their `and` forms were here, which is the
   * shape of gap that has no workaround: "published, or written by me" is not two
   * `where` calls, and the alternative is `orWhere(query => …)` with the clause
   * rebuilt by hand inside it.
   *
   * Each one is its `and` sibling with the boolean flipped, and the clause types
   * already carried the field.
   */
  orWhereJsonContains(column: string, value: unknown, not = false): this {
    this.query.wheres.push({ type: 'jsonContains', column, value, not, boolean: 'or' })

    return this
  }

  orWhereJsonDoesntContain(column: string, value: unknown): this {
    return this.orWhereJsonContains(column, value, true)
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
  orWhereFullText(columns: string | string[], value: string): this {
    this.query.wheres.push({
      type: 'fullText',
      columns: Array.isArray(columns) ? columns : [columns],
      value,
      boolean: 'or'
    })

    return this
  }

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

    // `where('total', undefined)` and `where('total', '=', undefined)` differ only
    // in how many arguments arrived; inspecting the values cannot tell them apart.
    // biome-ignore lint/complexity/noArguments: the arity is the information.
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

    // `where('total', undefined)` and `where('total', '=', undefined)` differ only
    // in how many arguments arrived; inspecting the values cannot tell them apart.
    // biome-ignore lint/complexity/noArguments: the arity is the information.
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

  orWhereNot(column: string, value: Value): this {
    return this.orWhere(column, '!=', value)
  }

  orWhereColumn(first: string, operator: Operator, second: string): this {
    this.query.wheres.push({ type: 'column', first, operator, second, boolean: 'or' })

    return this
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

  whereIn(column: string, values: Value[], boolean: Boolean_ = 'and'): this {
    this.query.wheres.push({ type: 'in', column, values, not: false, boolean })
    return this
  }

  whereNotIn(column: string, values: Value[], boolean: Boolean_ = 'and'): this {
    this.query.wheres.push({ type: 'in', column, values, not: true, boolean })
    return this
  }

  /** `or`-joined, which is what `orWhereBelongsTo` needs. */
  orWhereIn(column: string, values: Value[]): this {
    return this.whereIn(column, values, 'or')
  }

  orWhereNotIn(column: string, values: Value[]): this {
    return this.whereNotIn(column, values, 'or')
  }

  /**
   * `whereDate('created_at', '2026-08-25')` — the five date comparisons.
   *
   * Two arguments mean equals, three take an operator, which is the overload every
   * `where` in this builder carries. A `Date` is formatted to the part being
   * compared, because binding a full timestamp against `date(col)` matches nothing
   * — the comparison is against the extracted value, not the original.
   *
   * The SQL is per dialect and is in the grammars: `date(col)` for MySQL,
   * `strftime('%Y-%m-%d', col)` for SQLite, `col::date` for Postgres. Writing this
   * as `whereRaw` at a call site is what those three lines exist to prevent.
   */
  whereDate(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('date', column, rest, 'and')
  }

  orWhereDate(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('date', column, rest, 'or')
  }

  whereTime(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('time', column, rest, 'and')
  }

  orWhereTime(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('time', column, rest, 'or')
  }

  whereDay(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('day', column, rest, 'and')
  }

  orWhereDay(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('day', column, rest, 'or')
  }

  whereMonth(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('month', column, rest, 'and')
  }

  orWhereMonth(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('month', column, rest, 'or')
  }

  whereYear(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('year', column, rest, 'and')
  }

  orWhereYear(column: string, ...rest: DateArgs): this {
    return this.addDateWhere('year', column, rest, 'or')
  }

  private addDateWhere(
    part: 'date' | 'time' | 'day' | 'month' | 'year',
    column: string,
    rest: DateArgs,
    boolean: Boolean_
  ): this {
    /**
     * The arity, without reading `arguments`.
     *
     * `whereDate(col, x)` means equals and `whereDate(col, '>', x)` takes an
     * operator, and only the count tells them apart — `x` may itself be a string
     * that looks like an operator. A rest parameter carries that count in the type
     * as well as at run time, which `arguments.length` does not.
     */
    const [operator, resolved] = this.normaliseOperator(
      rest[0] as Operator | Value,
      rest[1] as Value,
      rest.length + 1
    )

    this.query.wheres.push({
      type: 'date',
      part,
      column,
      operator,
      value: formatDatePart(part, resolved),
      boolean
    })

    return this
  }

  /**
   * `union(other)` — the rows of both queries, duplicates removed.
   *
   * A builder or a callback that builds one, and both are accepted.
   * `unionAll` keeps the duplicates and is the cheaper of the two, because `union`
   * has to sort to find them.
   *
   * The other query's own order and limit belong to that query; an order over the
   * whole union is not supported here, and `orderBy` on this builder is written
   * before the unions rather than after them.
   */
  union(other: QueryBuilder | ((query: QueryBuilder) => void), all = false): this {
    const query = this.resolveUnion(other)

    this.query.unions = [...(this.query.unions ?? []), { query: query.components, all }]

    return this
  }

  unionAll(other: QueryBuilder | ((query: QueryBuilder) => void)): this {
    return this.union(other, true)
  }

  private resolveUnion(other: QueryBuilder | ((query: QueryBuilder) => void)): QueryBuilder {
    if (typeof other !== 'function') return other

    const nested = new QueryBuilder(this.connection)

    other(nested)

    return nested
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

  orWhereLike(column: string, value: string): this {
    return this.orWhere(column, 'like', value)
  }

  /**
   * Is the key there at all?
   *
   * Not the same question as whether it is null: a key holding null is present
   * and one that was never written is not, and `where('meta->beta', null)`
   * cannot tell them apart.
   */
  whereJsonContainsKey(column: string, boolean: Boolean_ = 'and', not = false): this {
    this.query.wheres.push({ type: 'jsonContainsKey', column, not, boolean })

    return this
  }

  whereJsonDoesntContainKey(column: string): this {
    return this.whereJsonContainsKey(column, 'and', true)
  }

  orWhereJsonContainsKey(column: string): this {
    return this.whereJsonContainsKey(column, 'or')
  }

  orWhereJsonDoesntContainKey(column: string): this {
    return this.whereJsonContainsKey(column, 'or', true)
  }

  /** Do the stored array and this one share a member? */
  whereJsonOverlaps(column: string, value: unknown, boolean: Boolean_ = 'and', not = false): this {
    this.query.wheres.push({ type: 'jsonOverlaps', column, value, not, boolean })

    return this
  }

  whereJsonDoesntOverlap(column: string, value: unknown): this {
    return this.whereJsonOverlaps(column, value, 'and', true)
  }

  orWhereJsonOverlaps(column: string, value: unknown): this {
    return this.whereJsonOverlaps(column, value, 'or')
  }

  orWhereJsonDoesntOverlap(column: string, value: unknown): this {
    return this.whereJsonOverlaps(column, value, 'or', true)
  }

  whereNotLike(column: string, value: string): this {
    return this.where(column, 'not like', value)
  }

  orWhereNotLike(column: string, value: string): this {
    return this.orWhere(column, 'not like', value)
  }

  // ------------------------------------------------------ many columns, once

  /**
   * One comparison against several columns — `whereAny`, the search box.
   *
   * A search across five columns was a nested closure and five `orWhere`s at
   * every call site. These are that closure: `whereAny` joins them with `or`,
   * `whereAll` with `and`, and `whereNone` is `whereAny` negated as a whole,
   * which is not the same as comparing each column with `not`.
   */
  whereAny(columns: string[], operator: Operator, value?: Value): this
  whereAny(columns: string[], value: Value): this
  whereAny(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'or', 'and', false)
  }

  orWhereAny(columns: string[], operator: Operator, value?: Value): this
  orWhereAny(columns: string[], value: Value): this
  orWhereAny(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'or', 'or', false)
  }

  whereAll(columns: string[], operator: Operator, value?: Value): this
  whereAll(columns: string[], value: Value): this
  whereAll(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'and', 'and', false)
  }

  orWhereAll(columns: string[], operator: Operator, value?: Value): this
  orWhereAll(columns: string[], value: Value): this
  orWhereAll(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'and', 'or', false)
  }

  whereNone(columns: string[], operator: Operator, value?: Value): this
  whereNone(columns: string[], value: Value): this
  whereNone(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'or', 'and', true)
  }

  orWhereNone(columns: string[], operator: Operator, value?: Value): this
  orWhereNone(columns: string[], value: Value): this
  orWhereNone(columns: string[], operatorOrValue?: Operator | Value, value?: Value): this {
    // biome-ignore lint/complexity/noArguments: the arity says whether an operator was given.
    return this.whereMany(columns, operatorOrValue, value, arguments.length, 'or', 'or', true)
  }

  private whereMany(
    columns: string[],
    operatorOrValue: Operator | Value,
    value: Value,
    argumentCount: number,
    inner: Boolean_,
    boolean: Boolean_,
    not: boolean
  ): this {
    const [operator, resolved] = this.normaliseOperator(operatorOrValue, value, argumentCount)

    if (columns.length === 0) return this

    this.query.wheres.push({
      type: 'nested',
      not,
      boolean,
      wheres: columns.map((column, index) => ({
        type: 'basic' as const,
        column,
        operator,
        value: resolved,
        boolean: index === 0 ? ('and' as Boolean_) : inner
      }))
    })

    return this
  }

  // -------------------------------------------------- comparing with columns

  /**
   * Is this value inside the window two columns describe?
   *
   * `whereBetweenColumns('2026-01-01', ['starts_at', 'ends_at'])` — the bounds
   * are columns, so a row whose own two dates bracket the value matches.
   */
  whereBetweenColumns(
    value: Value | Expression,
    columns: [string, string],
    boolean: Boolean_ = 'and',
    not = false
  ): this {
    this.query.wheres.push({
      type: 'betweenColumns',
      column: isExpression(value) ? value : (value as string),
      columns,
      not,
      boolean
    })

    return this
  }

  whereNotBetweenColumns(value: Value | Expression, columns: [string, string]): this {
    return this.whereBetweenColumns(value, columns, 'and', true)
  }

  orWhereBetweenColumns(value: Value | Expression, columns: [string, string]): this {
    return this.whereBetweenColumns(value, columns, 'or')
  }

  orWhereNotBetweenColumns(value: Value | Expression, columns: [string, string]): this {
    return this.whereBetweenColumns(value, columns, 'or', true)
  }

  /** `whereValueBetween` reads the other way round, and means the same thing. */
  whereValueBetween(value: Value | Expression, columns: [string, string]): this {
    return this.whereBetweenColumns(value, columns)
  }

  /**
   * Compare several columns as one tuple — `(a, b) > (1, 2)`.
   *
   * Lexicographic, not column by column: that is the difference between a keyset
   * page that skips rows and one that does not.
   */
  whereRowValues(
    columns: string[],
    operator: Operator,
    values: Value[],
    boolean: Boolean_ = 'and'
  ): this {
    if (columns.length !== values.length) {
      throw new Error('whereRowValues needs as many values as columns.')
    }

    this.query.wheres.push({
      type: 'rowValues',
      columns,
      operator: String(operator),
      values,
      boolean
    })

    return this
  }

  orWhereRowValues(columns: string[], operator: Operator, values: Value[]): this {
    return this.whereRowValues(columns, operator, values, 'or')
  }

  /**
   * Equal, counting two nulls as equal.
   *
   * `where('deleted_by', null)` becomes `is null` and a bound null matches
   * nothing at all, so a comparison against a value that *might* be null is
   * silently empty. This is the comparison that is not.
   */
  whereNullSafeEquals(column: string, value: Value, boolean: Boolean_ = 'and', not = false): this {
    this.query.wheres.push({ type: 'nullSafe', column, value, not, boolean })

    return this
  }

  orWhereNullSafeEquals(column: string, value: Value): this {
    return this.whereNullSafeEquals(column, value, 'or')
  }

  whereNotNullSafeEquals(column: string, value: Value): this {
    return this.whereNullSafeEquals(column, value, 'and', true)
  }

  orWhereNull(column: string): this {
    return this.whereNull(column, 'or')
  }

  orWhereNotNull(column: string): this {
    return this.whereNull(column, 'or', true)
  }

  orWhereBetween(column: string, values: [Value, Value]): this {
    this.query.wheres.push({ type: 'between', column, values, not: false, boolean: 'or' })

    return this
  }

  orWhereNotBetween(column: string, values: [Value, Value]): this {
    this.query.wheres.push({ type: 'between', column, values, not: true, boolean: 'or' })

    return this
  }

  orWhereRaw(sql: string, bindings: unknown[] = []): this {
    this.query.wheres.push({ type: 'raw', sql, bindings, boolean: 'or' })

    return this
  }

  whereRaw(sql: string, bindings: unknown[] = []): this {
    this.query.wheres.push({ type: 'raw', sql, bindings, boolean: 'and' })
    return this
  }

  whereExists(
    callback: (query: QueryBuilder) => void,
    not = false,
    boolean: Boolean_ = 'and'
  ): this {
    const nested = new QueryBuilder(this.connection)
    callback(nested)

    this.query.wheres.push({ type: 'exists', query: nested.components, not, boolean })
    return this
  }

  whereNotExists(callback: (query: QueryBuilder) => void): this {
    return this.whereExists(callback, true)
  }

  /**
   * The same, joined with `or` — what `orWhereHas` compiles to.
   *
   * The clause already carried a `boolean`; nothing could set it to `'or'` until
   * now, which is why `orWhereHas` was missing rather than merely unwritten.
   */
  orWhereExists(callback: (query: QueryBuilder) => void, not = false): this {
    return this.whereExists(callback, not, 'or')
  }

  orWhereNotExists(callback: (query: QueryBuilder) => void): this {
    return this.whereExists(callback, true, 'or')
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

  orHaving(column: string, operator: Operator, value: Value): this {
    this.query.havings.push({ type: 'basic', column, operator, value, boolean: 'or' })

    return this
  }

  orHavingRaw(sql: string, bindings: unknown[] = []): this {
    this.query.havings.push({ type: 'raw', sql, bindings, boolean: 'or' })

    return this
  }

  havingRaw(sql: string, bindings: unknown[] = []): this {
    this.query.havings.push({ type: 'raw', sql, bindings, boolean: 'and' })
    return this
  }

  /**
   * `order by`, and the direction is checked because the type cannot be.
   *
   * A sort direction is the one part of a query that reaches an application as a
   * *string from outside* — `?sort=name&dir=asc` — and TypeScript's `'asc' | 'desc'`
   * says nothing at runtime about a value that arrived over HTTP. It used to be
   * interpolated straight into the SQL, which was a real injection with no `raw` in
   * sight. Measured against a live SQLite database, this ran:
   *
   * ```
   * order by "name" asc, (CASE WHEN (SELECT secret FROM users WHERE …) LIKE 't%'
   *                       THEN 0 ELSE 1 END) asc
   * ```
   *
   * The row order then answers the guess — a blind oracle needing no second
   * statement, so whether the driver allows one is beside the point. Refused for
   * that reason.
   *
   * Reach for `orderByRaw` when an expression is what you mean. That name is the
   * whole difference: it says at the call site that the string is trusted.
   */
  orderBy(column: string | Expression, direction: 'asc' | 'desc' = 'asc'): this {
    const wanted = String(direction).toLowerCase()

    if (wanted !== 'asc' && wanted !== 'desc') {
      throw new Error(`Order direction must be "asc" or "desc", saw [${direction}].`)
    }

    this.query.orders.push({ column, direction: wanted })

    return this
  }

  /**
   * Order by an expression — `orderByRaw('field(status, ?, ?)', ['open', 'done'])`.
   *
   * `orderBy` refuses a string it cannot quote as a column, deliberately: that
   * is the blind-oracle injection this name exists to make visible at the call
   * site.
   */
  orderByRaw(sql: string, bindings: unknown[] = []): this {
    this.query.orders.push({ column: raw(sql), bindings: [...bindings] })

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
   * The replacement form is what key-based walking needs:
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

  /**
   * One page, plus the totals a numbered pager needs.
   *
   * The count and the page go out together against two clones — neither reads
   * the other's answer, and awaiting them in turn spent a round trip on nothing.
   *
   * On the query builder as well as the model one because a report, an aggregate
   * or a join that is not a model is the query most likely to be large enough to
   * need paging.
   */
  async paginate(
    page?: number,
    perPage = 15,
    options: PaginatorOptions = {}
  ): Promise<Paginator<T>> {
    const current = Math.max(1, page ?? Paginators.currentPage(options.pageName))

    const [total, data] = await Promise.all([
      this.clone().count(),
      this.clone().forPage(current, perPage).get()
    ])

    return new Paginator(data, total, perPage, current, options)
  }

  /**
   * One page and one query: `perPage + 1` rows, the extra one dropped.
   *
   * All a Previous/Next control needs, and on a large filtered table the count
   * the numbered paginator pays for is usually the slower of its two queries.
   */
  async simplePaginate(
    page?: number,
    perPage = 15,
    options: PaginatorOptions = {}
  ): Promise<SimplePaginator<T>> {
    const current = Math.max(1, page ?? Paginators.currentPage(options.pageName))
    // Not `forPage(current, perPage + 1)`: that would move the offset too, so
    // page two would start a row late.
    const rows = await this.clone()
      .offset((current - 1) * perPage)
      .limit(perPage + 1)
      .get()
    const more = rows.count() > perPage

    return new SimplePaginator(more ? rows.take(perPage) : rows, perPage, current, more, options)
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

  /**
   * Apply the callback when the condition holds.
   *
   * The condition may be a function, and is called if it is: without that,
   * `when(() => wantsDrafts(), …)` always runs, because a function object is
   * truthy. The resolved value reaches the callback, so a search term needs no
   * capture, and `otherwise` is the else branch.
   */
  when<V>(
    condition: V | ((query: this) => V),
    callback: (query: this, value: NonNullable<V>) => unknown,
    otherwise?: (query: this, value: V) => unknown
  ): this {
    const resolved = (
      typeof condition === 'function' ? (condition as (query: this) => V)(this) : condition
    ) as V

    if (resolved) callback(this, resolved as NonNullable<V>)
    else otherwise?.(this, resolved)

    return this
  }

  unless<V>(
    condition: V | ((query: this) => V),
    callback: (query: this, value: V) => unknown,
    otherwise?: (query: this, value: NonNullable<V>) => unknown
  ): this {
    const resolved = (
      typeof condition === 'function' ? (condition as (query: this) => V)(this) : condition
    ) as V

    if (!resolved) callback(this, resolved)
    else otherwise?.(this, resolved as NonNullable<V>)

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

  /**
   * The SQL and its bindings, from one pass over the query.
   *
   * `toSql()` and `getBindings()` each compiled the whole tree, so anything that
   * wanted both — every `joinSub`, `fromSub`, `crossJoinSub` and `insertUsing` —
   * compiled it twice. Nested subqueries multiply that: two levels deep is four
   * compilations of the innermost query for one build.
   */
  /**
   * Whether the caller asked for an order.
   *
   * The paging walkers need to know. Without an `order by`, the rows a `limit` /
   * `offset` pair returns are whatever the database found convenient, and nothing
   * says page two continues where page one stopped — so an unordered offset walk
   * is not merely slow, it has no defined page boundaries.
   */
  get ordered(): boolean {
    return this.query.orders.length > 0
  }

  compile(): { sql: string; bindings: unknown[] } {
    this.applyBeforeQuery()

    return this.connection.grammar.compileSelect(this.query)
  }

  toSql(): string {
    return this.compile().sql
  }

  getBindings(): unknown[] {
    return this.compile().bindings
  }

  /**
   * The statement with its bindings written in — ready to paste into a client.
   *
   * For reading, never for running: the values are quoted for display and this
   * is not an escaping routine. Every placeholder is filled in order, which is
   * also how a mispaired binding becomes visible.
   */
  toRawSql(): string {
    const { sql, bindings } = this.compile()
    const values = [...bindings]

    return sql.replace(/\?|\$\d+/g, (token) => {
      const index = token.startsWith('$') ? Number(token.slice(1)) - 1 : 0
      const value = token.startsWith('$') ? bindings[index] : values.shift()

      return literal(value)
    })
  }

  /** Print the statement with its bindings written in, and carry on. */
  dumpRawSql(): this {
    console.log(this.toRawSql())

    return this
  }

  /** Print it and stop — the one that is meant to be deleted again. */
  dd(): never {
    console.log(this.toRawSql())

    throw new Error('Query dumped.')
  }

  /**
   * Run something over the query before it is compiled.
   *
   * A scope applied from outside the call site — a tenant filter, a soft-delete
   * condition — without the caller having to remember it.
   */
  beforeQuery(callback: (query: QueryBuilder<T>) => void): this {
    this.beforeCallbacks.push(callback)

    return this
  }

  /** Run something over the rows before they are handed back. */
  afterQuery(callback: (rows: Collection<T>) => Collection<T> | undefined): this {
    this.afterCallbacks.push(callback)

    return this
  }

  private applyBeforeQuery(): void {
    if (this.beforeCallbacks.length === 0) return

    // Taken and cleared first: compiling twice must not apply them twice, and a
    // callback that adds another must not make this endless.
    const callbacks = [...this.beforeCallbacks]
    this.beforeCallbacks.length = 0

    for (const callback of callbacks) callback(this)
  }

  private applyAfterQuery(rows: Collection<T>): Collection<T> {
    let result = rows

    for (const callback of this.afterCallbacks) {
      const returned = callback(result)

      if (returned !== undefined) result = returned
    }

    return result
  }

  // ------------------------------------------------------------- index hints

  /**
   * `use index (…)` — advice for the planner, MySQL's alone.
   *
   * Postgres has no hints by design and SQLite's `indexed by` is a different
   * promise: it fails when the index cannot be used, where a hint is ignored.
   * So the others drop it rather than refusing — a hint changes nothing about
   * the answer.
   */
  useIndex(index: string): this {
    this.query.indexHint = { type: 'use', index }

    return this
  }

  forceIndex(index: string): this {
    this.query.indexHint = { type: 'force', index }

    return this
  }

  ignoreIndex(index: string): this {
    this.query.indexHint = { type: 'ignore', index }

    return this
  }

  // ----------------------------------------------------------------- reading

  async get(): Promise<Collection<T>> {
    const { sql, bindings } = this.compile()

    return this.applyAfterQuery(new Collection(await this.connection.select<T>(sql, bindings)))
  }

  /**
   * Exactly one row, or an error naming which of the two happened.
   *
   * `first()` on a query that matched three rows answers one of them and says
   * nothing, which is how a lookup by a column that turned out not to be unique
   * goes unnoticed for months.
   */
  async sole(): Promise<T> {
    const rows = await this.clone().limit(2).get()

    if (rows.count() === 0) throw new Error(`No rows found in [${this.query.from}].`)
    if (rows.count() > 1) throw new Error(`More than one row found in [${this.query.from}].`)

    return rows.first() as T
  }

  /** The one value of the one row, with the same two errors. */
  async soleValue<V = unknown>(column: string): Promise<V> {
    const row = await this.clone().select(column).sole()

    return row[column] as V
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

  /**
   * Walk the table in pages, so a large table never lands in memory at once.
   *
   * By key when the caller asked for no particular order, by offset when they did.
   *
   * Offset paging makes the database find and discard every row before the page it
   * wants, so walking the whole table re-scans a growing prefix each time: 100,000
   * rows took 0.51s against 0.21s by key, 400,000 took 4.06s against 0.70s. The
   * keyset walk grows with the table; the offset walk grows with the square of it.
   *
   * Only when nothing was ordered, because then no order was promised and paging by
   * key is the stricter behaviour, not a looser one. A caller who wrote `orderBy`
   * meant that order and keeps it — along with its cost.
   */
  async chunk(
    size: number,
    callback: (rows: Collection<T>, page: number) => Promise<unknown> | unknown
  ): Promise<void> {
    if (!this.ordered) return this.chunkByKey(size, callback)

    let page = 1

    while (true) {
      const rows = await this.clone().forPage(page, size).get()
      if (rows.isEmpty()) return

      if ((await callback(rows, page)) === false) return
      if (rows.count() < size) return

      page += 1
    }
  }

  /**
   * The same walk, paged by the primary key.
   *
   * `cursor()` already knows how; this is `chunk`'s callback shape over it, with
   * the page number the callback is given counted here rather than by the
   * database.
   */
  private async chunkByKey(
    size: number,
    callback: (rows: Collection<T>, page: number) => Promise<unknown> | unknown,
    column = 'id'
  ): Promise<void> {
    let last: Value = null
    let page = 1
    let first = true

    while (true) {
      const next = this.clone()
      if (!first) next.where(column, '>', last)

      const rows = await next.orderBy(column).limit(size).get()
      if (rows.isEmpty()) return

      if ((await callback(rows, page)) === false) return
      if (rows.count() < size) return

      last = (rows.last() as T)[column] as Value
      first = false
      page += 1

      if (last === null || last === undefined) return
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

  /** The other spelling of the same aggregate. */
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

  orHavingNull(column: string): this {
    this.query.havings.push({ type: 'null', column, not: false, boolean: 'or' })

    return this
  }

  orHavingNotNull(column: string): this {
    this.query.havings.push({ type: 'null', column, not: true, boolean: 'or' })

    return this
  }

  orHavingBetween(column: string, values: [Value, Value]): this {
    this.query.havings.push({ type: 'between', column, values, not: false, boolean: 'or' })

    return this
  }

  havingNotNull(column: string): this {
    this.query.havings.push({ type: 'null', column, not: true, boolean: 'and' })

    return this
  }

  // ------------------------------------------------------------ paginating

  /**
   * The page after a known id.
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

  /**
   * Write a row unless a live one already holds its key — one statement.
   *
   * The primitive behind a lock and behind `Cache::add`. `guard` names the column
   * carrying the expiry and `alive` the value it must exceed to still count; the
   * answer is whether this caller wrote the row.
   */
  async claim(
    row: Record<string, unknown>,
    uniqueBy: string[],
    guard: string,
    alive: unknown
  ): Promise<boolean> {
    const { sql, bindings } = this.connection.grammar.compileClaim(
      this.query.from,
      row,
      uniqueBy,
      guard,
      alive
    )

    return (await this.connection.affectingStatement(sql, bindings)) > 0
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
   * Several counters in one statement.
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
  async insertUsing(columns: string[], query: QueryBuilder<Row> | Subqueryable): Promise<number> {
    const sub = compileSub(query)
    const table = this.connection.grammar.wrapTable(this.query.from)
    const wrapped = columns.map((column) => this.connection.grammar.wrap(column)).join(', ')

    // `affectingStatement`, not `statement`: the latter is for DDL and reports
    // nothing, so this used to answer 0 while inserting the rows perfectly well.
    return this.connection.affectingStatement(
      `insert into ${table} (${wrapped}) ${sub.sql}`,
      sub.bindings
    )
  }

  /**
   * The rows another query selects, skipping the ones that collide.
   *
   * `insertUsing` with a unique index is all-or-nothing: one duplicate loses the
   * whole batch, which for a backfill run twice is the difference between a
   * no-op and an error.
   */
  async insertOrIgnoreUsing(
    columns: string[],
    query: QueryBuilder<Row> | Subqueryable
  ): Promise<number> {
    const sub = compileSub(query)
    const grammar = this.connection.grammar
    const { prefix, suffix } = grammar.compileIgnoreParts()
    const wrapped = columns.map((column) => grammar.wrap(column)).join(', ')

    return this.connection.affectingStatement(
      `${prefix} ${grammar.wrapTable(this.query.from)} (${wrapped}) ${sub.sql}${suffix}`,
      sub.bindings
    )
  }

  /**
   * Update from another table — `update … from …`.
   *
   * The joins added with `join()` become the `from` list and their conditions
   * become part of the `where`, because an `update … from` has no `on` clause to
   * put them in. MySQL has no such statement and says so.
   */
  async updateFrom(values: Record<string, unknown>): Promise<number> {
    const { sql, bindings } = this.connection.grammar.compileUpdateFrom(this.query, values)

    return this.connection.affectingStatement(sql, bindings)
  }

  /** Seconds the server may spend on this statement, where it can be told. */
  timeout(seconds: number): this {
    this.query.timeout = seconds

    return this
  }

  /**
   * The value of one expression — `rawValue('count(*) filter (where paid)')`.
   *
   * A single answer out of SQL the builder has no word for, without a column
   * name to read it back by.
   */
  async rawValue<V = unknown>(sql: string, bindings: unknown[] = []): Promise<V | undefined> {
    const query = this.clone()

    query.query.columns = [raw(`${sql} as ${this.connection.grammar.wrap('raw_value')}`)]
    query.query.columnBindings = [...bindings]

    const row = await query.limit(1).get()

    return row.first()?.raw_value as V | undefined
  }

  /**
   * Select from a subquery — `from (select …) as alias`.
   *
   * For anything that has to aggregate and then filter on the aggregate, which a
   * `having` cannot always express.
   */
  fromSub(query: QueryBuilder<Row> | Subqueryable, alias: string): this {
    const sub = compileSub(query)

    this.query.fromRaw = raw(`(${sub.sql}) as ${this.connection.grammar.wrapTable(alias)}`)
    this.query.fromBindings = [...sub.bindings]

    return this
  }

  /** A cartesian join against a subquery. */
  crossJoinSub(query: QueryBuilder<Row> | Subqueryable, alias: string): this {
    const sub = compileSub(query)

    this.query.joins.push({
      type: 'cross',
      table: raw(`(${sub.sql}) as ${this.connection.grammar.wrapTable(alias)}`),
      wheres: [],
      bindings: sub.bindings
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
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return `'${value.toISOString()}'`

  return `'${String(value).replace(/'/g, "''")}'`
}

/** `(value)` or `(operator, value)` — the two shapes a date comparison takes. */
export type DateArgs = [Operator | Value] | [Operator, Value]

/**
 * The part of a date a comparison is actually against.
 *
 * `whereMonth('created_at', new Date(...))` compares the *month*, so binding the
 * whole timestamp would match nothing — the left side is `03`, the right side a
 * full ISO string, so the formatting has to happen here.
 *
 * Day and month are padded to two digits, because that is what the extraction
 * answers: `strftime('%m', …)` gives `03`, and `'03' = '3'` is false.
 */
function formatDatePart(part: 'date' | 'time' | 'day' | 'month' | 'year', value: unknown): unknown {
  if (!(value instanceof Date)) {
    // A number for a day or a month still has to be padded to match.
    if ((part === 'day' || part === 'month') && typeof value === 'number') {
      return String(value).padStart(2, '0')
    }

    return value
  }

  const iso = value.toISOString()

  switch (part) {
    case 'date':
      return iso.slice(0, 10)
    case 'time':
      return iso.slice(11, 19)
    case 'day':
      return iso.slice(8, 10)
    case 'month':
      return iso.slice(5, 7)
    default:
      return iso.slice(0, 4)
  }
}
