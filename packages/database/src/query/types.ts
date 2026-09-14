/**
 * How near two vectors are — pgvector's three operators.
 *
 * `cosine` is what an embedding usually wants: it compares direction and ignores
 * magnitude, and a model's output length carries no meaning. `l2` is ordinary
 * straight-line distance. `inner` is the negative inner product, which pgvector
 * negates so that "nearest" is still "smallest" and an index scan can be used.
 */
export type VectorMetric = 'l2' | 'cosine' | 'inner'

import type { Expression } from './expression.ts'

export type Boolean_ = 'and' | 'or'

export type WhereClause =
  | { type: 'basic'; column: string; operator: string; value: unknown; boolean: Boolean_ }
  | { type: 'column'; first: string; operator: string; second: string; boolean: Boolean_ }
  | { type: 'null'; column: string; not: boolean; boolean: Boolean_ }
  | { type: 'in'; column: string; values: unknown[]; not: boolean; boolean: Boolean_ }
  | { type: 'between'; column: string; values: [unknown, unknown]; not: boolean; boolean: Boolean_ }
  | { type: 'exists'; query: QueryComponents; not: boolean; boolean: Boolean_ }
  /**
   * `whereDate`, `whereTime`, `whereDay`, `whereMonth`, `whereYear`.
   *
   * One clause for the five, because the SQL differs only in which part of the
   * timestamp is extracted — and it differs *per dialect*, which is the whole
   * reason this is a clause and not a `whereRaw` at the call site.
   */
  | {
      type: 'date'
      part: 'date' | 'time' | 'day' | 'month' | 'year'
      column: string
      operator: string
      value: unknown
      boolean: Boolean_
    }
  | { type: 'nested'; wheres: WhereClause[]; not?: boolean; boolean: Boolean_ }
  /**
   * `whereBetweenColumns` — a value, or a column, between two columns.
   *
   * The bounds are columns rather than values, which is what a date range stored
   * as two columns needs: `? between starts_at and ends_at` asks whether a
   * moment falls inside a row's window, and nothing else in the builder can say
   * that without raw SQL.
   */
  | {
      type: 'betweenColumns'
      column: string | Expression
      columns: [string, string]
      not: boolean
      boolean: Boolean_
    }
  /** `(a, b) >= (?, ?)` — a keyset page, compared as a tuple. */
  | {
      type: 'rowValues'
      columns: string[]
      operator: string
      values: unknown[]
      boolean: Boolean_
    }
  /** `a <=> ?` — equal, and two nulls are equal. */
  | { type: 'nullSafe'; column: string; value: unknown; not: boolean; boolean: Boolean_ }
  | { type: 'raw'; sql: string; bindings: unknown[]; boolean: Boolean_ }
  | { type: 'jsonContains'; column: string; value: unknown; not: boolean; boolean: Boolean_ }
  /** `whereJsonContainsKey('meta->flags')` — is the key there at all? */
  | { type: 'jsonContainsKey'; column: string; not: boolean; boolean: Boolean_ }
  /** `whereJsonOverlaps('tags', ['a', 'b'])` — do the two arrays share anything? */
  | { type: 'jsonOverlaps'; column: string; value: unknown; not: boolean; boolean: Boolean_ }
  | {
      type: 'jsonLength'
      column: string
      operator: string
      value: unknown
      boolean: Boolean_
    }
  | {
      type: 'vectorDistance'
      column: string
      metric: VectorMetric
      vector: number[]
      operator: string
      value: number
      boolean: Boolean_
    }
  | { type: 'fullText'; columns: string[]; value: string; boolean: Boolean_ }

export type JoinClause = {
  type: 'inner' | 'left' | 'right' | 'cross' | 'straight'
  table: string | Expression
  /**
   * A join whose subquery may refer to the row being joined to.
   *
   * `on true` rather than a condition: a lateral join's correlation lives inside
   * the subquery, which is the whole point of it — the three-most-recent-per-user
   * query that otherwise needs a window function.
   */
  lateral?: boolean
  wheres: WhereClause[]
  /**
   * Bindings belonging to the joined table itself.
   *
   * Only a subquery join has any, and they bind *before* the on-clause's — which
   * is why they live here rather than being appended with the wheres.
   */
  bindings?: unknown[]
}

export type OrderClause = {
  column?: string | Expression
  direction?: 'asc' | 'desc'
  /** Bindings belonging to a raw order — `orderByRaw('field(id, ?, ?)', …)`. */
  bindings?: unknown[]
  /** Set by `orderByVector`: order by distance from this vector. */
  vector?: { column: string; metric: VectorMetric; values: number[] }
}

export type AggregateClause = {
  fn: 'count' | 'min' | 'max' | 'sum' | 'avg'
  column: string
}

/**
 * The full description of a query, independent of any dialect.
 *
 * Keeping this a plain data structure — rather than letting the builder emit SQL
 * as methods are called — is what allows one builder to serve every grammar, and
 * what makes `toSql()` possible without executing anything.
 */
export type QueryComponents = {
  from: string

  /**
   * Queries joined on with `union` — `select … union select …`.
   *
   * Each one keeps its own components rather than a compiled string, because the
   * bindings have to be collected in the order the SQL reads them, and that is
   * only knowable while compiling.
   */
  unions?: Array<{ query: QueryComponents; all: boolean }>
  /**
   * `from (subquery) as alias`, kept apart from `from`.
   *
   * A separate field rather than widening `from`, because every write path —
   * insert, update, delete — needs a real table name and a subquery there is
   * meaningless. It is also why it is an `Expression`: a plain string would be
   * quoted as one very long identifier, which is what the first version did.
   */
  fromRaw?: Expression
  /**
   * Bindings belonging to a subquery in `from`.
   *
   * Kept apart from the wheres' because SQL reads `from` first: a placeholder in
   * the subquery is filled before any in the `where` that follows it, and one
   * flat list appended in the wrong order silently pairs values with the wrong
   * question marks.
   */
  fromBindings?: unknown[]
  columns: Array<string | Expression>
  /**
   * Bindings belonging to a sub-select in the column list.
   *
   * Separate because SQL reads the select list first: a placeholder there is
   * filled before any in the `from` or the `where` that follow it.
   */
  columnBindings?: unknown[]
  distinct: boolean
  aggregate?: AggregateClause
  joins: JoinClause[]
  wheres: WhereClause[]
  groups: Array<string | Expression>
  havings: WhereClause[]
  orders: OrderClause[]
  limit?: number
  offset?: number
  lock?: 'update' | 'share'
  /** `use index (…)`, `force index (…)`, `ignore index (…)` — MySQL's hints. */
  indexHint?: { type: 'use' | 'force' | 'ignore'; index: string }
  /** Seconds the server is allowed to spend on this statement. */
  timeout?: number
}

/**
 * Deep-copy a query description while preserving class identity.
 *
 * `structuredClone` cannot be used here: it turns an `Expression` into a plain
 * object, so `isExpression()` starts returning false and raw SQL silently
 * becomes a bound parameter. Expressions are immutable, so sharing the
 * reference is both correct and cheaper.
 */
export function cloneQuery(query: QueryComponents): QueryComponents {
  return {
    from: query.from,
    fromRaw: query.fromRaw,
    fromBindings: query.fromBindings ? [...query.fromBindings] : undefined,
    columns: [...query.columns],
    columnBindings: query.columnBindings ? [...query.columnBindings] : undefined,
    distinct: query.distinct,
    aggregate: query.aggregate ? { ...query.aggregate } : undefined,
    joins: query.joins.map((join) => ({ ...join, wheres: cloneWheres(join.wheres) })),
    wheres: cloneWheres(query.wheres),
    groups: [...query.groups],
    havings: cloneWheres(query.havings),
    orders: query.orders.map((order) => ({ ...order })),
    limit: query.limit,
    offset: query.offset,
    lock: query.lock,
    indexHint: query.indexHint ? { ...query.indexHint } : undefined,
    timeout: query.timeout,
    unions: query.unions?.map((union) => ({ query: cloneQuery(union.query), all: union.all }))
  }
}

function cloneWheres(wheres: WhereClause[]): WhereClause[] {
  return wheres.map((where) => {
    if (where.type === 'nested') return { ...where, wheres: cloneWheres(where.wheres) }
    if (where.type === 'exists') return { ...where, query: cloneQuery(where.query) }
    if (where.type === 'in') return { ...where, values: [...where.values] }
    if (where.type === 'between') return { ...where, values: [...where.values] }
    if (where.type === 'raw') return { ...where, bindings: [...where.bindings] }

    return { ...where }
  })
}

export function emptyQuery(from = ''): QueryComponents {
  return {
    from,
    columns: [],
    distinct: false,
    joins: [],
    wheres: [],
    groups: [],
    havings: [],
    orders: []
  }
}
