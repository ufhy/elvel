import { Collection } from '@elysian/support'
import type { Connection, Row } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import { raw } from '../query/expression.ts'
import { attributeEncrypter, formatDateTime } from './casts.ts'
import type { Model, ModelClass } from './model.ts'

export type Paginated<M> = {
  data: Collection<M>
  total: number
  perPage: number
  currentPage: number
  lastPage: number
}

/**
 * A page reached by remembering where the last one ended.
 *
 * No `total` and no `lastPage`, on purpose: knowing them costs a `count(*)` over
 * the whole set, which is the expense cursor pagination exists to avoid. What it
 * buys is stability — an offset page silently repeats or skips rows when
 * something is inserted while a user is reading.
 */
export type CursorPage<M> = {
  data: Collection<M>
  perPage: number
  /** Pass back as `cursor` to get the next page. Null at the end. */
  nextCursor: string | null
  /** Null on the first page. */
  previousCursor: string | null
}

/**
 * A query builder that returns models instead of rows.
 *
 * It defers to the underlying `QueryBuilder` for SQL, adds hydration, eager
 * loading, and the soft-delete scope that would otherwise have to be remembered
 * at every call site.
 */
export class ModelBuilder<M extends Model> {
  private query?: QueryBuilder<Row>
  private readonly pending: Array<(query: QueryBuilder<Row>) => void> = []
  private readonly eagerLoad = new Set<string>()
  private trashed: 'exclude' | 'include' | 'only' = 'exclude'
  private readonly withoutScopes = new Set<string>()
  private readonly aggregates: Array<{
    relation: string
    fn: string
    column: string
    alias: string
  }> = []

  constructor(private readonly model: ModelClass<M>) {}

  /**
   * The underlying query builder. Async because the connection resolves lazily;
   * `toBase()` is the escape hatch once you already hold one.
   */
  async base(): Promise<QueryBuilder<Row>> {
    if (this.query) return this.query

    const connection: Connection = await (this.model as typeof Model).getConnection(
      (this.model as typeof Model).connection
    )

    const query = new QueryBuilder<Row>(connection, (this.model as typeof Model).getTable())

    for (const apply of this.pending) apply(query)
    this.applyTrashedScope(query)
    this.query = query
    this.applyGlobalScopes()
    this.applyAggregates(query)

    return query
  }

  /**
   * Constraints every query for this model carries, minus any the caller removed.
   *
   * Applied after the pending calls so `withoutGlobalScope` can be expressed
   * before the query exists.
   */
  private applyGlobalScopes(): void {
    const scopes = (this.model as typeof Model).globalScopes

    for (const [name, scope] of Object.entries(scopes)) {
      if (this.withoutScopes.has('*') || this.withoutScopes.has(name)) continue
      scope(this as never)
    }
  }

  /** Synchronous access for callers already inside an awaited chain. */
  toBase(): QueryBuilder<Row> {
    if (!this.query) {
      throw new Error('Call await base() before toBase().')
    }

    return this.query
  }

  private applyTrashedScope(query: QueryBuilder<Row>): void {
    if (!(this.model as typeof Model).softDeletes) return

    const column = (this.model as typeof Model).DELETED_AT

    if (this.trashed === 'exclude') query.whereNull(column)
    if (this.trashed === 'only') query.whereNotNull(column)
  }

  /**
   * Queue a call for when the query exists — the public form.
   *
   * A relation that needs to build a *peer* query (a subquery join, say) cannot do
   * it until the connection is resolved, which is what `base()` waits for.
   */
  deferBase(apply: (query: QueryBuilder<Row>) => void): this {
    return this.defer(apply)
  }

  /** Queue a call for when the query exists, keeping the API chainable. */
  private defer(apply: (query: QueryBuilder<Row>) => void): this {
    if (this.query) apply(this.query)
    else this.pending.push(apply)

    return this
  }

  // ----------------------------------------------------------- query proxying

  where(column: string, operator: string, value: unknown): this
  where(column: string, value: unknown): this
  where(callback: (query: QueryBuilder<Row>) => void): this
  where(...args: unknown[]): this {
    return this.defer((query) => {
      ;(query.where as (...rest: unknown[]) => unknown)(...args)
    })
  }

  orWhere(column: string, operator: string, value: unknown): this
  orWhere(column: string, value: unknown): this
  orWhere(callback: (query: QueryBuilder<Row>) => void): this
  orWhere(...args: unknown[]): this {
    return this.defer((query) => {
      ;(query.orWhere as (...rest: unknown[]) => unknown)(...args)
    })
  }

  whereIn(column: string, values: unknown[]): this {
    return this.defer((query) => {
      query.whereIn(column, values)
    })
  }

  whereNotIn(column: string, values: unknown[]): this {
    return this.defer((query) => {
      query.whereNotIn(column, values)
    })
  }

  whereNull(column: string): this {
    return this.defer((query) => {
      query.whereNull(column)
    })
  }

  whereNotNull(column: string): this {
    return this.defer((query) => {
      query.whereNotNull(column)
    })
  }

  whereBetween(column: string, values: [unknown, unknown]): this {
    return this.defer((query) => {
      query.whereBetween(column, values)
    })
  }

  whereJsonContains(column: string, value: unknown): this {
    return this.defer((query) => {
      query.whereJsonContains(column, value)
    })
  }

  whereJsonDoesntContain(column: string, value: unknown): this {
    return this.defer((query) => {
      query.whereJsonDoesntContain(column, value)
    })
  }

  /**
   * Search an encrypted column through its blind index.
   *
   * ```ts
   * const user = await User.query().whereBlind('email', 'ada@example.com').first()
   * ```
   *
   * The attribute names what you are searching for; the index column is looked
   * up from the model's `blindIndexes`. Naming the attribute rather than the
   * column is what keeps the call site readable and the fingerprinting — which
   * has to match how the row was written, context and all — in one place.
   */
  whereBlind(attribute: string, value: string): this {
    const model = this.model as unknown as typeof Model
    const column = model.blindIndexes[attribute]

    if (!column) {
      throw new Error(
        `[${model.name}] has no blind index for [${attribute}]. Add it to blindIndexes, and to the table.`
      )
    }

    const encrypter = attributeEncrypter()

    if (!encrypter?.blindIndex) {
      throw new Error('whereBlind() needs EncryptionServiceProvider. Register it in config/app.ts.')
    }

    const table = model.getTable()
    const fingerprint = encrypter.blindIndex(value, `${table}.${attribute}`)

    return this.defer((query) => {
      query.where(column, fingerprint)
    })
  }

  /** How many elements a JSON array holds — `whereJsonLength('meta->tags', '>', 2)`. */
  whereJsonLength(column: string, operator: string | number, value?: unknown): this {
    return this.defer((query) => {
      query.whereJsonLength(column, operator, value)
    })
  }

  orWhereJsonLength(column: string, operator: string | number, value?: unknown): this {
    return this.defer((query) => {
      query.orWhereJsonLength(column, operator, value)
    })
  }

  whereFullText(columns: string | string[], value: string): this {
    return this.defer((query) => {
      query.whereFullText(columns, value)
    })
  }

  whereLike(column: string, value: string): this {
    return this.defer((query) => {
      query.whereLike(column, value)
    })
  }

  whereRaw(sql: string, bindings: unknown[] = []): this {
    return this.defer((query) => {
      query.whereRaw(sql, bindings)
    })
  }

  join(table: string, first: string, operator: string, second: string): this {
    return this.defer((query) => {
      query.join(table, first, operator, second)
    })
  }

  leftJoin(table: string, first: string, operator: string, second: string): this {
    return this.defer((query) => {
      query.leftJoin(table, first, operator, second)
    })
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    return this.defer((query) => {
      query.orderBy(column, direction)
    })
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

  limit(count: number): this {
    return this.defer((query) => {
      query.limit(count)
    })
  }

  offset(count: number): this {
    return this.defer((query) => {
      query.offset(count)
    })
  }

  take(count: number): this {
    return this.limit(count)
  }

  skip(count: number): this {
    return this.offset(count)
  }

  select(...columns: string[]): this {
    return this.defer((query) => {
      query.select(...columns)
    })
  }

  groupBy(...columns: string[]): this {
    return this.defer((query) => {
      query.groupBy(...columns)
    })
  }

  whereColumn(first: string, operator: string, second: string): this {
    return this.defer((query) => {
      query.whereColumn(first, operator, second)
    })
  }

  whereExists(callback: (query: QueryBuilder<Row>) => void): this {
    return this.defer((query) => {
      query.whereExists(callback as never)
    })
  }

  orderByRaw(sql: string): this {
    return this.defer((query) => {
      query.orderBy(raw(sql))
    })
  }

  /** Stream rows one at a time instead of materialising the whole result. */
  async *lazy(size = 1000): AsyncGenerator<M> {
    let page = 1

    while (true) {
      const models = await this.clone()
        .offset((page - 1) * size)
        .limit(size)
        .get()

      if (models.isEmpty()) return

      for (const model of models) yield model
      if (models.count() < size) return

      page += 1
    }
  }

  /** Exactly one result, or an error — Laravel's `sole`. */
  async sole(): Promise<M> {
    const models = await this.clone().limit(2).get()

    if (models.isEmpty()) throw new ModelNotFoundError((this.model as typeof Model).name)
    if (models.count() > 1) {
      throw new Error(`Multiple results for ${(this.model as typeof Model).name}.`)
    }

    return models.first() as M
  }

  async firstWhere(column: string, value: unknown): Promise<M | undefined> {
    return this.clone().where(column, value).first()
  }

  when(condition: unknown, callback: (builder: this) => void): this {
    if (condition) callback(this)
    return this
  }

  /** Apply a scope defined as `scopeActive(query)` on the model. */
  scope(name: string, ...args: unknown[]): this {
    const method = (this.model as unknown as Record<string, unknown>)[
      `scope${name.charAt(0).toUpperCase()}${name.slice(1)}`
    ]

    if (typeof method !== 'function') {
      throw new Error(`Scope [${name}] is not defined on ${this.model.name}.`)
    }

    ;(method as (builder: ModelBuilder<M>, ...rest: unknown[]) => void).call(
      this.model,
      this,
      ...args
    )

    return this
  }

  withoutGlobalScope(name: string): this {
    this.withoutScopes.add(name)
    return this
  }

  withoutGlobalScopes(): this {
    this.withoutScopes.add('*')
    return this
  }

  // ---------------------------------------------------------- relation filters

  /**
   * Restrict to models that have at least one related row — Laravel's `has`.
   *
   * Compiled as a correlated `exists` subquery rather than a join, so it never
   * multiplies the parent rows.
   */
  has(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.addRelationExists(relation, callback, false)
  }

  whereHas(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.has(relation, callback)
  }

  doesntHave(relation: string): this {
    return this.addRelationExists(relation, undefined, true)
  }

  whereDoesntHave(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.addRelationExists(relation, callback, true)
  }

  private addRelationExists(
    relation: string,
    callback: ((query: ModelBuilder<never>) => void) | undefined,
    negate: boolean
  ): this {
    return this.defer((query) => {
      const probe = new (this.model as unknown as new () => Model)()
      const constraint = probe
        .resolveRelation(relation)
        .existsConstraint((this.model as typeof Model).getTable())

      // whereExists supplies its own nested builder; configure that one rather
      // than returning a builder of our own, which it would ignore.
      const build = (sub: QueryBuilder<Row>) => {
        sub
          .from(constraint.table)
          .selectRaw('1')
          .whereColumn(constraint.foreign, '=', constraint.local)

        if (callback) {
          const nested = new ModelBuilder(constraint.related as never)
          callback(nested as never)
          nested.applyTo(sub)
        }
      }

      if (negate) query.whereNotExists(build as never)
      else query.whereExists(build as never)
    })
  }

  /** Copy this builder's pending constraints onto a raw query. */
  private applyTo(query: QueryBuilder<Row>): void {
    for (const apply of this.pending) apply(query)
  }

  // ------------------------------------------------------------- aggregates

  /** `withCount('posts')` adds a `posts_count` column, without an extra query. */
  withCount(...relations: string[]): this {
    for (const relation of relations.flat()) {
      this.aggregates.push({ relation, fn: 'count', column: '*', alias: `${relation}_count` })
    }

    return this
  }

  withSum(relation: string, column: string): this {
    this.aggregates.push({ relation, fn: 'sum', column, alias: `${relation}_sum_${column}` })
    return this
  }

  withMax(relation: string, column: string): this {
    this.aggregates.push({ relation, fn: 'max', column, alias: `${relation}_max_${column}` })
    return this
  }

  withMin(relation: string, column: string): this {
    this.aggregates.push({ relation, fn: 'min', column, alias: `${relation}_min_${column}` })
    return this
  }

  withAvg(relation: string, column: string): this {
    this.aggregates.push({ relation, fn: 'avg', column, alias: `${relation}_avg_${column}` })
    return this
  }

  private applyAggregates(query: QueryBuilder<Row>): void {
    if (this.aggregates.length === 0) return

    const grammar = query.connectionRef.grammar
    const table = (this.model as typeof Model).getTable()
    const probe = new (this.model as unknown as new () => Model)()

    // Keep the model's own columns: adding a select would otherwise drop them.
    query.select(`${table}.*`)

    for (const aggregate of this.aggregates) {
      const constraint = probe.resolveRelation(aggregate.relation).existsConstraint(table)
      const column = aggregate.column === '*' ? '*' : grammar.wrap(aggregate.column)

      query.selectRaw(
        `(select ${aggregate.fn}(${column}) from ${grammar.wrapTable(constraint.table)}` +
          ` where ${grammar.wrap(constraint.foreign)} = ${grammar.wrap(constraint.local)})` +
          ` as ${grammar.wrap(aggregate.alias)}`
      )
    }
  }

  // --------------------------------------------------------------- soft deletes

  withTrashed(): this {
    this.trashed = 'include'
    return this
  }

  onlyTrashed(): this {
    this.trashed = 'only'
    return this
  }

  // ------------------------------------------------------------- eager loading

  with(...relations: string[]): this {
    for (const relation of relations.flat()) this.eagerLoad.add(relation)
    return this
  }

  /**
   * Load each relation with one extra query and match the results back by key.
   *
   * This is the two-query strategy from `HasOneOrMany::addEagerConstraints` and
   * `match()`: collect the parents' keys, fetch the children in a single
   * `where in`, build a dictionary, then assign. Parents with a null key are
   * skipped rather than matched against null.
   */
  async eagerLoadRelations(models: M[], relations: string[] = [...this.eagerLoad]): Promise<void> {
    if (models.length === 0 || relations.length === 0) return

    for (const name of relations) {
      // `posts.comments` — load the near relation, then recurse into the far one.
      const [head, ...rest] = name.split('.')
      const relation = models[0]?.resolveRelation(head as string)
      if (!relation) continue

      await relation.eagerLoad(models, head as string)

      if (rest.length === 0) continue

      const related = models.flatMap((model) => {
        const value = model.getRelation(head as string)

        if (value instanceof Collection) return value.all() as Model[]

        return value ? [value as Model] : []
      })

      if (related.length === 0) continue

      const nested = await (related[0] as Model).newQuery()
      await nested.eagerLoadRelations(related as never[], [rest.join('.')])
    }
  }

  // ---------------------------------------------------------------- retrieval

  async get(): Promise<Collection<M>> {
    const query = await this.base()
    const rows = await query.get()

    const models = rows.all().map((row) => (this.model as typeof Model).hydrate(row) as M)

    await this.eagerLoadRelations(models)

    return new Collection(models)
  }

  async first(): Promise<M | undefined> {
    const query = await this.base()
    const row = await query.clone().limit(1).get()
    const found = row.first()

    if (!found) return undefined

    const model = (this.model as typeof Model).hydrate(found) as M
    await this.eagerLoadRelations([model])

    return model
  }

  async firstOrFail(): Promise<M> {
    const model = await this.first()

    if (!model) {
      throw new ModelNotFoundError((this.model as typeof Model).name)
    }

    return model
  }

  async find(id: unknown): Promise<M | undefined> {
    return this.where((this.model as typeof Model).primaryKey, id).first()
  }

  async findOrFail(id: unknown): Promise<M> {
    const model = await this.find(id)

    if (!model) {
      throw new ModelNotFoundError((this.model as typeof Model).name, id)
    }

    return model
  }

  /** Find the first match, or create it — Laravel's `firstOrCreate`. */
  async firstOrCreate(attributes: Row, values: Row = {}): Promise<M> {
    const query = this.clone()
    for (const [column, value] of Object.entries(attributes)) query.where(column, value)

    const existing = await query.first()
    if (existing) return existing

    return (this.model as typeof Model).create({ ...attributes, ...values }) as Promise<M>
  }

  async updateOrCreate(attributes: Row, values: Row = {}): Promise<M> {
    const query = this.clone()
    for (const [column, value] of Object.entries(attributes)) query.where(column, value)

    const existing = await query.first()

    if (existing) {
      await existing.update(values)
      return existing
    }

    return (this.model as typeof Model).create({ ...attributes, ...values }) as Promise<M>
  }

  async pluck<V = unknown>(column: string): Promise<Collection<V>> {
    return (await this.base()).pluck<V>(column)
  }

  async count(): Promise<number> {
    return (await this.base()).count()
  }

  async exists(): Promise<boolean> {
    return (await this.base()).exists()
  }

  async max<V = number>(column: string): Promise<V | null> {
    return (await this.base()).max<V>(column)
  }

  async min<V = number>(column: string): Promise<V | null> {
    return (await this.base()).min<V>(column)
  }

  async sum(column: string): Promise<number> {
    return (await this.base()).sum(column)
  }

  async avg(column: string): Promise<number | null> {
    return (await this.base()).avg(column)
  }

  /** One page of results, plus the totals a UI needs. */
  async paginate(page = 1, perPage = 15): Promise<Paginated<M>> {
    const total = await this.clone().count()
    const data = await this.clone()
      .offset((Math.max(1, page) - 1) * perPage)
      .limit(perPage)
      .get()

    return {
      data,
      total,
      perPage,
      currentPage: Math.max(1, page),
      lastPage: Math.max(1, Math.ceil(total / perPage))
    }
  }

  /** Mass update, bypassing model events exactly as Laravel's does. */
  async update(values: Row): Promise<number> {
    const query = await this.base()

    if ((this.model as typeof Model).timestamps) {
      // Drivers cannot bind a Date; format it the way the casts do.
      values = {
        ...values,
        [(this.model as typeof Model).UPDATED_AT]: formatDateTime(new Date())
      }
    }

    return query.update(values)
  }

  async delete(): Promise<number> {
    const query = await this.base()

    if ((this.model as typeof Model).softDeletes) {
      return query.update({
        [(this.model as typeof Model).DELETED_AT]: formatDateTime(new Date())
      })
    }

    return query.delete()
  }

  async forceDelete(): Promise<number> {
    return (await this.base()).delete()
  }

  /**
   * `lazy()` by key: the streaming form of `chunkById`.
   *
   * The same reason to exist — an offset stream skips rows when they are deleted
   * mid-walk — with the same fix, in generator shape.
   */
  async *lazyById(size = 1000, column?: string): AsyncGenerator<M> {
    const key = column ?? (this.model as typeof Model).primaryKey
    let lastId: unknown

    while (true) {
      const models = await this.clone()
        .deferBase((query) => {
          query.reorder(key, 'asc')

          if (lastId !== undefined) query.where(key, '>', lastId as never)
        })
        .limit(size)
        .get()

      if (models.isEmpty()) return

      for (const model of models) yield model

      lastId = models.all()[models.count() - 1]?.attributes[key]

      if (models.count() < size || lastId === undefined || lastId === null) return
    }
  }

  /** `chunkById` walking backwards — newest first, for a cleanup that trims tails. */
  async chunkByIdDesc(
    size: number,
    callback: (models: Collection<M>) => Promise<unknown> | unknown,
    column?: string
  ): Promise<void> {
    const key = column ?? (this.model as typeof Model).primaryKey
    let lastId: unknown

    while (true) {
      const page = this.clone().deferBase((query) => {
        query.reorder(key, 'desc')

        if (lastId !== undefined) query.where(key, '<', lastId as never)
      })

      const models = await page.limit(size).get()

      if (models.isEmpty()) return
      if ((await callback(models)) === false) return

      lastId = models.all()[models.count() - 1]?.attributes[key]

      if (models.count() < size) return
      if (lastId === undefined || lastId === null) return
    }
  }

  /**
   * Walk the table by **key**, not by offset — `chunkById`.
   *
   * `chunk()` pages with `offset`, and that is correct only while nothing changes
   * underneath it: delete a row from an earlier page and everything shifts back
   * one, so the next page skips a row that was never seen. Deleting *as you walk*
   * — which is the commonest reason to chunk at all — does exactly that.
   *
   * Remembering the last key instead means each page asks for `where id > ?`, and
   * neither an insert nor a delete can move the boundary.
   */
  async chunkById(
    size: number,
    callback: (models: Collection<M>) => Promise<unknown> | unknown,
    column?: string
  ): Promise<void> {
    const key = column ?? (this.model as typeof Model).primaryKey
    let lastId: unknown

    while (true) {
      const page = this.clone().deferBase((query) => {
        // Any order the caller set is replaced: walking by key requires the key's
        // order, and honouring both would page in one order while filtering in
        // another.
        query.reorder(key, 'asc')

        if (lastId !== undefined) query.where(key, '>', lastId as never)
      })

      const models = await page.limit(size).get()

      if (models.isEmpty()) return
      if ((await callback(models)) === false) return

      lastId = models.all()[models.count() - 1]?.attributes[key]

      if (models.count() < size) return
      if (lastId === undefined || lastId === null) return
    }
  }

  /**
   * One page, addressed by a cursor rather than a number — `cursorPaginate`.
   *
   * The cursor carries the last row's key, base64url-encoded as Laravel's is, so
   * it can travel in a URL. `previousCursor` points *backwards* from the first row
   * of this page, which is what makes paging back work without counting.
   */
  async cursorPaginate(
    perPage = 15,
    cursor?: string | null,
    columns?: string | string[]
  ): Promise<CursorPage<M>> {
    /**
     * Several columns page like a phone book: surname first, and the given name
     * only breaks ties. `['created_at', 'id']` therefore compiles to
     * `created_at > ? OR (created_at = ? AND id > ?)` — the key at the end is what
     * makes a page boundary exact when two rows share a timestamp, and it should
     * almost always be there.
     */
    const keys =
      columns === undefined
        ? [(this.model as typeof Model).primaryKey]
        : Array.isArray(columns)
          ? columns
          : [columns]

    const decoded = decodeCursor(cursor)
    const backwards = decoded?.pointsBackwards === true
    const operator = backwards ? '<' : '>'

    const page = this.clone().deferBase((query) => {
      query.reorder()
      for (const key of keys) query.orderBy(key, backwards ? 'desc' : 'asc')

      if (!decoded) return

      const values = Array.isArray(decoded.value) ? decoded.value : [decoded.value]

      /**
       * The compound where, built from the outside in — Laravel's recursive
       * `addCursorConditions`, iteratively: each level fixes the columns before it
       * with `=` and moves the one at hand with `>`/`<`.
       */
      query.where((outer) => {
        for (let index = 0; index < keys.length; index += 1) {
          const clause = (nested: typeof outer) => {
            for (let fixed = 0; fixed < index; fixed += 1) {
              nested.where(keys[fixed] as string, '=', values[fixed] as never)
            }

            nested.where(keys[index] as string, operator, values[index] as never)
          }

          if (index === 0) clause(outer)
          else outer.orWhere((nested) => clause(nested as typeof outer))
        }
      })
    })

    // One more than asked for: its presence is how "there is a next page" is
    // answered without a second query.
    const models = await page.limit(perPage + 1).get()
    const hasMore = models.count() > perPage
    const rows = hasMore ? models.all().slice(0, perPage) : models.all()

    // Reading backwards returns rows in reverse; the caller wants them the way
    // round they would have been read forwards.
    const ordered = backwards ? [...rows].reverse() : rows

    const valuesOf = (model: M | undefined) =>
      model === undefined ? undefined : keys.map((key) => model.attributes[key])

    const first = valuesOf(ordered[0])
    const last = valuesOf(ordered[ordered.length - 1])

    return {
      data: new Collection(ordered),
      perPage,
      nextCursor:
        (backwards ? true : hasMore) && last !== undefined ? encodeCursor(last, false) : null,
      previousCursor:
        (decoded === undefined ? false : backwards ? hasMore : true) && first !== undefined
          ? encodeCursor(first, true)
          : null
    }
  }

  async chunk(
    size: number,
    callback: (models: Collection<M>) => Promise<unknown> | unknown
  ): Promise<void> {
    let page = 1

    while (true) {
      const models = await this.clone()
        .offset((page - 1) * size)
        .limit(size)
        .get()

      if (models.isEmpty()) return
      if ((await callback(models)) === false) return
      if (models.count() < size) return

      page += 1
    }
  }

  clone(): ModelBuilder<M> {
    const copy = new ModelBuilder<M>(this.model)

    copy.pending.push(...this.pending)
    for (const relation of this.eagerLoad) copy.eagerLoad.add(relation)
    // Aggregates must survive: paginate(), first() and find() all clone, so
    // dropping them silently lost every withCount() on a paginated query.
    copy.aggregates.push(...this.aggregates)
    copy.trashed = this.trashed

    return copy
  }

  async toSql(): Promise<string> {
    return (await this.base()).toSql()
  }
}

export class ModelNotFoundError extends Error {
  constructor(
    readonly model: string,
    readonly id?: unknown
  ) {
    super(
      id === undefined
        ? `No query results for ${model}.`
        : `No query results for ${model} [${String(id)}].`
    )
    this.name = 'ModelNotFoundError'
  }
}

/** `{ value, pointsBackwards }`, base64url — the shape Laravel's Cursor encodes. */
function encodeCursor(value: unknown, pointsBackwards: boolean): string {
  return Buffer.from(JSON.stringify({ value, pointsBackwards })).toString('base64url')
}

function decodeCursor(
  cursor: string | null | undefined
): { value: unknown; pointsBackwards: boolean } | undefined {
  if (!cursor) return undefined

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      value?: unknown
      pointsBackwards?: unknown
    }

    if (parsed.value === undefined) return undefined

    return { value: parsed.value, pointsBackwards: parsed.pointsBackwards === true }
  } catch {
    // A cursor is a URL parameter, so it arrives from a user: rubbish means the
    // first page, not a 500.
    return undefined
  }
}
