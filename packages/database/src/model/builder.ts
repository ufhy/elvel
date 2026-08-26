import { Collection } from '@elvel/support'
import type { Connection, Row } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import { raw } from '../query/expression.ts'
import type { VectorMetric } from '../query/types.ts'
import { attributeEncrypter, formatDateTime } from './casts.ts'
import type { Model, ModelClass } from './model.ts'
import type { EagerConstraint } from './relations.ts'

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

  /** A constraint per eager-loaded relation, from the object form of `with`. */
  private readonly eagerConstraints = new Map<string, EagerConstraint>()
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

  /** Nearest by vector distance — the ordering half of a similarity search. */
  orderByVector(column: string, vector: number[], metric: VectorMetric = 'cosine'): this {
    return this.defer((query) => {
      query.orderByVector(column, vector, metric)
    })
  }

  /** Near enough by vector distance — the threshold half. */
  whereVectorDistance(
    column: string,
    vector: number[],
    operator: string,
    value: number,
    metric: VectorMetric = 'cosine'
  ): this {
    return this.defer((query) => {
      query.whereVectorDistance(column, vector, operator, value, metric)
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

  /**
   * The `or` half of the family — Laravel's `orHas` and friends.
   *
   * Four methods that were missing rather than declined, and there is no way
   * round them: "posts, or comments" cannot be said with `whereHas` twice, and
   * writing the `exists` subquery by hand means knowing the foreign key the
   * relation already knows.
   */
  orHas(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.addRelationExists(relation, callback, false, 'or')
  }

  orWhereHas(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.orHas(relation, callback)
  }

  orDoesntHave(relation: string): this {
    return this.addRelationExists(relation, undefined, true, 'or')
  }

  orWhereDoesntHave(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    return this.addRelationExists(relation, callback, true, 'or')
  }

  /**
   * `whereRelation('posts', 'is_published', true)` — Laravel's `whereRelation`.
   *
   * The same as `whereHas` with a one-line callback, and worth having for the
   * reason Laravel added it: the callback form buries the condition inside a
   * closure, and a filter on a relation is the commonest thing anybody writes.
   */
  whereRelation(relation: string, column: string, operator?: unknown, value?: unknown): this {
    return this.whereHas(relation, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  orWhereRelation(relation: string, column: string, operator?: unknown, value?: unknown): this {
    return this.orWhereHas(relation, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  whereDoesntHaveRelation(
    relation: string,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.whereDoesntHave(relation, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  orWhereDoesntHaveRelation(
    relation: string,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.orWhereDoesntHave(relation, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  // ------------------------------------------------------------ morph filters

  /**
   * `whereHasMorph('taggable', [Post, Video])` — Laravel's `whereHasMorph`.
   *
   * The method a morphTo needs, because `whereHas` cannot serve one: the rows
   * point at different tables and no single `exists` spans them. So this
   * constrains the **type** column and runs one `exists` per type, joined with
   * `or` — which is what `hasMorph` does in `QueriesRelationships`.
   *
   * `'*'` means every type the relation declares. Laravel finds them by querying
   * `select distinct taggable_type`, and that is one round trip before the real
   * query, on a column that may not be indexed. The relation already lists its
   * types here, so this reads them instead — which also means a type with no rows
   * yet still gets its subquery, where Laravel's would silently leave it out.
   *
   * The callback receives the query **and the type**, so a constraint can differ
   * per table: a column on `posts` may not exist on `videos`.
   */
  whereHasMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.addMorphExists(relation, types, callback, false, 'and')
  }

  orWhereHasMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.addMorphExists(relation, types, callback, false, 'or')
  }

  whereDoesntHaveMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.addMorphExists(relation, types, callback, true, 'and')
  }

  orWhereDoesntHaveMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.addMorphExists(relation, types, callback, true, 'or')
  }

  /** `hasMorph` and `doesntHaveMorph` are the same four without the `where` in front. */
  hasMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.whereHasMorph(relation, types, callback)
  }

  orHasMorph(
    relation: string,
    types: MorphTypes,
    callback?: (query: ModelBuilder<never>, type: string) => void
  ): this {
    return this.orWhereHasMorph(relation, types, callback)
  }

  doesntHaveMorph(relation: string, types: MorphTypes): this {
    return this.whereDoesntHaveMorph(relation, types)
  }

  orDoesntHaveMorph(relation: string, types: MorphTypes): this {
    return this.orWhereDoesntHaveMorph(relation, types)
  }

  /**
   * `whereMorphedTo('taggable', post)` — which row it points at, not what it has.
   *
   * Four shapes, all of them Laravel's: a model, several models, a type name on
   * its own, and `null` — which asks for the rows pointing at nothing, and is a
   * `where … is null` on the type column rather than a comparison with the word
   * "null".
   */
  whereMorphedTo(relation: string, model: MorphTarget, boolean: 'and' | 'or' = 'and'): this {
    return this.addMorphedTo(relation, model, boolean, false)
  }

  orWhereMorphedTo(relation: string, model: MorphTarget): this {
    return this.addMorphedTo(relation, model, 'or', false)
  }

  whereNotMorphedTo(relation: string, model: MorphTarget): this {
    return this.addMorphedTo(relation, model, 'and', true)
  }

  orWhereNotMorphedTo(relation: string, model: MorphTarget): this {
    return this.addMorphedTo(relation, model, 'or', true)
  }

  /** `whereMorphRelation('taggable', [Post], 'published', true)` — the sugar form. */
  whereMorphRelation(
    relation: string,
    types: MorphTypes,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.whereHasMorph(relation, types, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  orWhereMorphRelation(
    relation: string,
    types: MorphTypes,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.orWhereHasMorph(relation, types, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  whereMorphDoesntHaveRelation(
    relation: string,
    types: MorphTypes,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.whereDoesntHaveMorph(relation, types, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  orWhereMorphDoesntHaveRelation(
    relation: string,
    types: MorphTypes,
    column: string,
    operator?: unknown,
    value?: unknown
  ): this {
    return this.orWhereDoesntHaveMorph(relation, types, (query) => {
      applyRelationCondition(query, column, operator, value)
    })
  }

  private addMorphExists(
    relation: string,
    types: MorphTypes,
    callback: ((query: ModelBuilder<never>, type: string) => void) | undefined,
    negate: boolean,
    boolean: 'and' | 'or'
  ): this {
    const morph = this.morphOf(relation)
    const table = (this.model as typeof Model).getTable()
    const resolved = resolveMorphTypes(types, morph.types, relation)

    return this.defer((query) => {
      const group = (nested: QueryBuilder<Row>) => {
        for (const [alias, related] of resolved) {
          nested.orWhere((branch) => {
            branch.where(`${table}.${morph.typeColumn}`, '=', alias as never)

            const build = (sub: QueryBuilder<Row>) => {
              sub
                .from((related as typeof Model).getTable())
                .selectRaw('1')
                .whereColumn(
                  `${(related as typeof Model).getTable()}.${(related as typeof Model).primaryKey}`,
                  '=',
                  `${table}.${morph.idColumn}`
                )

              if (callback) {
                const inner = new ModelBuilder(related as never)
                callback(inner as never, alias)
                inner.applyTo(sub)
              }
            }

            if (negate) branch.whereNotExists(build as never)
            else branch.whereExists(build as never)
          })
        }
      }

      if (boolean === 'or') query.orWhere(group as never)
      else query.where(group as never)
    })
  }

  private addMorphedTo(
    relation: string,
    model: MorphTarget,
    boolean: 'and' | 'or',
    negate: boolean
  ): this {
    const morph = this.morphOf(relation)
    const table = (this.model as typeof Model).getTable()
    const typeColumn = `${table}.${morph.typeColumn}`

    /**
     * `null` asks for the rows that point at nothing.
     *
     * A comparison would never match — the column holds a type name or nothing at
     * all — so this is the one shape that has to become `is null`.
     */
    if (model === null) {
      return this.defer((query) => {
        // `negate`, not `!negate`: `whereMorphedTo(…, null)` asks for the rows
        // pointing at nothing, so it is `is null`. Inverted, it answered every
        // row *except* the one the caller asked for.
        query.whereNull(typeColumn, boolean, negate)
      })
    }

    if (typeof model === 'string') {
      const alias = morphAliasFor(model, morph.resolve)

      return this.defer((query) => {
        if (boolean === 'or') query.orWhere(typeColumn, negate ? '!=' : '=', alias as never)
        else query.where(typeColumn, negate ? '!=' : '=', alias as never)
      })
    }

    const models = iterableOf(model)

    if (models.length === 0) {
      throw new Error('whereMorphedTo() was given an empty list, which would match nothing.')
    }

    /**
     * Grouped by type, because the keys only mean anything beside their type.
     *
     * Two models of different types share an `id` space by accident; a flat
     * `type in (…) and id in (…)` would match a post whose id happens to equal a
     * video's. Laravel groups for the same reason.
     */
    const byType = new Map<string, unknown[]>()

    for (const one of models) {
      const alias = (one.constructor as typeof Model).getMorphClass()
      const keys = byType.get(alias) ?? []

      keys.push(one.attributes[(one.constructor as typeof Model).primaryKey])
      byType.set(alias, keys)
    }

    return this.defer((query) => {
      const group = (nested: QueryBuilder<Row>) => {
        for (const [alias, keys] of byType) {
          nested.orWhere((branch) => {
            branch
              .where(typeColumn, '=', alias as never)
              .whereIn(`${table}.${morph.idColumn}`, keys as never[])
          })
        }
      }

      const apply = boolean === 'or' ? query.orWhere.bind(query) : query.where.bind(query)

      if (!negate) {
        apply(group as never)

        return
      }

      /**
       * "Not any of these", written as the negation of each branch.
       *
       * `¬(A ∨ B)` is `¬A ∧ ¬B`, and the second form is the one this query
       * builder can say: there is no `not (…)` clause in the grammar, only a
       * negated comparison. Negating the branches instead needs no grammar change
       * and compiles to the same rows.
       */
      apply(((nested: QueryBuilder<Row>) => {
        for (const [alias, keys] of byType) {
          nested.where((branch) => {
            branch
              .where(typeColumn, '!=', alias as never)
              .orWhereNotIn(`${table}.${morph.idColumn}`, keys as never[])
          })
        }
      }) as never)
    })
  }

  /** The morphTo behind a name, or a message naming what it actually is. */
  private morphOf(relation: string): MorphColumns {
    const probe = new (this.model as unknown as new () => Model)()
    const found = probe.resolveRelation(relation) as unknown as {
      morphColumns?: () => MorphColumns
    }

    if (typeof found.morphColumns !== 'function') {
      throw new Error(
        `Relation [${relation}] on ${this.model.name} is not a morphTo, so the morph query methods cannot use it.`
      )
    }

    return found.morphColumns()
  }

  /**
   * `withWhereHas('posts', cb)` — filter by the relation *and* load it, once.
   *
   * Two things that are almost always wanted together and are easy to write out
   * of step: `whereHas` narrows the parents, `with` loads the children, and a
   * constraint written into one and not the other gives a page listing authors
   * who have published posts alongside all of their drafts.
   */
  withWhereHas(relation: string, callback?: (query: ModelBuilder<never>) => void): this {
    this.whereHas(relation, callback)

    return callback === undefined
      ? this.with(relation)
      : this.with({ [relation]: callback as EagerConstraint })
  }

  /** The same for the sugar form: `withWhereRelation('posts', 'published', 1)`. */
  withWhereRelation(relation: string, column: string, operator?: unknown, value?: unknown): this {
    this.whereRelation(relation, column, operator, value)

    return this.with({
      [relation]: (query) => {
        applyRelationCondition(query, column, operator, value)
      }
    })
  }

  /**
   * `whereAttachedTo(tag)` — the rows joined to this one through a pivot.
   *
   * The many-to-many counterpart of `whereBelongsTo`, and it compiles to
   * `has(relation, query => query.whereKey(keys))` rather than to a join on the
   * pivot: the pivot is the relation's business, and `has` already knows it.
   *
   * The relation name is guessed as the plural of the class — `Tag` gives
   * `tags` — which is Laravel's guess too, and refused rather than approximated
   * when the relation is not a many-to-many.
   */
  whereAttachedTo(related: Model | Iterable<Model>, relation?: string): this {
    return this.addAttachedTo(related, relation, 'and')
  }

  orWhereAttachedTo(related: Model | Iterable<Model>, relation?: string): this {
    return this.addAttachedTo(related, relation, 'or')
  }

  private addAttachedTo(
    related: Model | Iterable<Model>,
    relation: string | undefined,
    boolean: 'and' | 'or'
  ): this {
    const list = iterableOf(related)
    const first = list[0]

    if (first === undefined) {
      throw new Error('whereAttachedTo() was given an empty list, which would match nothing.')
    }

    const name = relation ?? pluralRelationNameFor(first)
    const probe = new (this.model as unknown as new () => Model)()
    const found = probe.resolveRelation(name) as unknown as {
      attachedKeys?: () => { pivotColumn: string; relatedKey: string }
    }

    if (typeof found.attachedKeys !== 'function') {
      throw new Error(
        `Relation [${name}] on ${this.model.name} is not a belongsToMany, so whereAttachedTo() cannot use it.`
      )
    }

    const { pivotColumn, relatedKey } = found.attachedKeys()
    const keys = list.map((one) => one.attributes[relatedKey]).filter((value) => value != null)
    const constrain = (query: ModelBuilder<never>) => {
      ;(query as unknown as { whereIn: (column: string, values: unknown[]) => void }).whereIn(
        pivotColumn,
        keys
      )
    }

    return boolean === 'or' ? this.orHas(name, constrain) : this.has(name, constrain)
  }

  /**
   * The general form the `with*` aggregates are built on — Laravel's `withAggregate`.
   *
   * `withAggregate('posts', 'votes', 'sum')` is `withSum('posts', 'votes')`. Worth
   * exposing for the function this framework has no shorthand for — a database's
   * own `string_agg`, or a `percentile_cont` — rather than making that reach for
   * `selectRaw` and rebuild the correlated subquery by hand.
   */
  withAggregate(relation: string, column: string, fn = 'count'): this {
    this.aggregates.push({
      relation,
      fn,
      column,
      alias: `${relation}_${fn}_${column === '*' ? 'all' : column}`
    })

    return this
  }

  /**
   * Copy another builder's constraints onto this one — `mergeConstraintsFrom`.
   *
   * For the case Laravel added it for: applying a relation's own constraints to a
   * query built elsewhere, so a scope defined once is not written twice.
   */
  mergeConstraintsFrom<Other extends Model>(other: ModelBuilder<Other>): this {
    for (const apply of (other as unknown as { pending: Array<(query: QueryBuilder<Row>) => void> })
      .pending) {
      this.defer(apply)
    }

    return this
  }

  private addRelationExists(
    relation: string,
    callback: ((query: ModelBuilder<never>) => void) | undefined,
    negate: boolean,
    boolean: 'and' | 'or' = 'and'
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

      if (boolean === 'or') query.orWhereExists(build as never, negate)
      else query.whereExists(build as never, negate)
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

  /**
   * `withExists('posts')` adds a `posts_exists` column — Laravel's `withExists`.
   *
   * Not `withCount(...) > 0`: counting makes the database walk every matching row
   * to answer a question that stops at the first one. On a parent with thousands
   * of children that is the whole difference.
   */
  withExists(...relations: string[]): this {
    for (const relation of relations.flat()) {
      this.aggregates.push({ relation, fn: 'exists', column: '*', alias: `${relation}_exists` })
    }

    return this
  }

  /**
   * `whereBelongsTo(author)` — the child rows that belong to this parent.
   *
   * Laravel's own test asserts what it compiles to, and it is not an `exists`
   * subquery: `whereIn('<table>.<foreignKey>', [<parent keys>])`. One model or a
   * list of them, and the relation is found by the parent's own class unless it is
   * named — which is what makes `whereBelongsTo(user, 'author')` necessary when a
   * table holds two keys to the same one.
   */
  whereBelongsTo(parents: Model | Iterable<Model>, relation?: string): this {
    return this.addBelongsTo(parents, relation, 'and')
  }

  orWhereBelongsTo(parents: Model | Iterable<Model>, relation?: string): this {
    return this.addBelongsTo(parents, relation, 'or')
  }

  private addBelongsTo(
    parents: Model | Iterable<Model>,
    relation: string | undefined,
    boolean: 'and' | 'or'
  ): this {
    /**
     * A model, an array, or a `Collection` — whatever `get()` handed back.
     *
     * Laravel's own test passes a `Collection` here, and `Array.isArray` is false
     * for one: the collection was treated as a single model, and the failure was
     * `Relation [collection] is not defined` — the class name, read off the
     * wrapper. Iterability is the property that actually distinguishes the two,
     * because a model is not iterable.
     */
    const list = iterableOf(parents)
    const first = list[0]

    if (first === undefined) {
      throw new Error('whereBelongsTo() needs at least one model to belong to.')
    }

    const name = relation ?? relationNameFor(first)
    const probe = new (this.model as unknown as new () => Model)()
    const found = probe.resolveRelation(name)

    if (typeof (found as { keys?: unknown }).keys !== 'function') {
      throw new Error(
        `Relation [${name}] on ${this.model.name} is not a belongsTo, so whereBelongsTo() cannot use it.`
      )
    }

    const { foreignKey, ownerKey } = (
      found as unknown as { keys: () => { foreignKey: string; ownerKey: string } }
    ).keys()

    const table = (this.model as typeof Model).getTable()
    const values = list.map((parent) => parent.attributes[ownerKey]).filter((key) => key != null)

    return this.defer((query) => {
      if (boolean === 'or') query.orWhereIn(`${table}.${foreignKey}`, values as never[])
      else query.whereIn(`${table}.${foreignKey}`, values as never[])
    })
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

      const where = `where ${grammar.wrap(constraint.foreign)} = ${grammar.wrap(constraint.local)}`

      /**
       * `exists` wraps the subquery; it is not a function applied inside one.
       *
       * `(select exists(*) …)` is not SQL. Laravel's own assertion for
       * `withExists` reads `exists(select * from … where …) as "foo_exists"`, and
       * the difference matters for more than syntax: this form lets the database
       * stop at the first matching row, which is the whole reason to reach for it
       * over `withCount`.
       */
      if (aggregate.fn === 'exists') {
        query.selectRaw(
          `exists(select * from ${grammar.wrapTable(constraint.table)} ${where})` +
            ` as ${grammar.wrap(aggregate.alias)}`
        )

        continue
      }

      query.selectRaw(
        `(select ${aggregate.fn}(${column}) from ${grammar.wrapTable(constraint.table)}` +
          ` ${where}) as ${grammar.wrap(aggregate.alias)}`
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

  /**
   * `with('posts')`, or `with({ posts: (query) => query.where('published', 1) })`.
   *
   * The constrained form is Laravel's `with(['posts' => fn ($q) => …])`, and it is
   * not a convenience: without it the only way to eager-load *part* of a relation
   * is to load all of it and filter in memory, which is the cost the eager load
   * existed to avoid.
   *
   * The constraint reaches the child query itself, so `orderBy` and `limit` inside
   * it apply per parent for the relations where that is meaningful.
   */
  with(...relations: Array<string | Record<string, EagerConstraint>>): this {
    for (const relation of relations.flat()) {
      if (typeof relation === 'string') {
        this.eagerLoad.add(relation)

        continue
      }

      for (const [name, constrain] of Object.entries(relation)) {
        this.eagerLoad.add(name)
        this.eagerConstraints.set(name, constrain)
      }
    }

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

      await relation.eagerLoad(models, head as string, this.eagerConstraints.get(name))

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

/**
 * `where(column, value)` or `where(column, operator, value)`, on a relation query.
 *
 * The two-argument form is what `whereRelation('posts', 'published', true)` means,
 * and it has to be told apart from the three-argument one at run time — the same
 * overload every query builder carries, in one place so the four `*Relation`
 * methods above cannot disagree about it.
 */
function applyRelationCondition(
  query: ModelBuilder<never>,
  column: string,
  operator?: unknown,
  value?: unknown
): void {
  if (value === undefined) {
    ;(query as unknown as { where: (column: string, value: unknown) => void }).where(
      column,
      operator
    )

    return
  }

  ;(
    query as unknown as { where: (column: string, operator: unknown, value: unknown) => void }
  ).where(column, operator, value)
}

/**
 * `whereBelongsTo(author)` with no name: the relation is guessed from the class.
 *
 * `Author` implies `author`, which is the convention Laravel guesses by too. It
 * is only a guess — a table holding two keys to the same model has two relations
 * and no way to choose between them — so `whereBelongsTo(user, 'editor')` is the
 * form for that, and this throws rather than picking one.
 */
function relationNameFor(parent: Model): string {
  const name = parent.constructor.name

  return name.charAt(0).toLowerCase() + name.slice(1)
}

/** A model, an array of them, or any iterable — as an array. */
function iterableOf(value: Model | Iterable<Model>): Model[] {
  if (Array.isArray(value)) return value

  const iterable = value as { [Symbol.iterator]?: unknown }

  return typeof iterable[Symbol.iterator] === 'function'
    ? [...(value as Iterable<Model>)]
    : [value as Model]
}

/**
 * What a morph query accepts as its list of types.
 *
 * A model class, several of them, or `'*'` for every type the relation declares.
 */
export type MorphTypes = ModelClass<Model> | Array<ModelClass<Model>> | '*'

/** What a morphTo relation tells the builder about itself. */
type MorphColumns = {
  typeColumn: string
  idColumn: string
  types: Record<string, ModelClass<Model>>
  resolve: (type: string) => ModelClass<Model> | undefined
}

/** What `whereMorphedTo` accepts: a model, several, a type name, or nothing. */
export type MorphTarget = Model | Iterable<Model> | string | null

/**
 * The types to build a subquery for, as `[storedName, class]` pairs.
 *
 * `'*'` reads the relation's own declaration rather than asking the database for
 * `select distinct taggable_type`, which is what Laravel does. Two reasons: it is
 * a round trip before the real query, on a column that is often unindexed; and a
 * type with no rows yet would be left out, so a query would quietly change shape
 * the day somebody inserted one.
 */
function resolveMorphTypes(
  types: MorphTypes,
  declared: Record<string, ModelClass<Model>>,
  relation: string
): Array<[string, ModelClass<Model>]> {
  if (types === '*') {
    const all = Object.values(declared)

    if (all.length === 0) {
      throw new Error(
        `Relation [${relation}] declares no types, so '*' has nothing to query. Name the types instead.`
      )
    }

    return all.map((model) => [(model as typeof Model).getMorphClass(), model])
  }

  const list = Array.isArray(types) ? types : [types]

  if (list.length === 0) {
    throw new Error(`No types were given for [${relation}], which would match nothing.`)
  }

  return list.map((model) => [(model as typeof Model).getMorphClass(), model])
}

/**
 * The name a type is stored under, given either the name or the class.
 *
 * `whereMorphedTo('taggable', 'posts')` may name the alias or the table, and a
 * caller should not have to know which of the two the morph map registered.
 */
function morphAliasFor(
  type: string,
  resolve: (type: string) => ModelClass<Model> | undefined
): string {
  const model = resolve(type)

  return model === undefined ? type : (model as typeof Model).getMorphClass()
}

/**
 * `Tag` implies the relation `tags` — the plural, for a many-to-many.
 *
 * `whereBelongsTo` guesses the singular because the child holds one key;
 * `whereAttachedTo` guesses the plural because a pivot holds many. Both are
 * guesses, and both take an explicit name for the tables that need one.
 */
function pluralRelationNameFor(related: Model): string {
  const name = related.constructor.name
  const camel = name.charAt(0).toLowerCase() + name.slice(1)

  if (/[^aeiou]y$/i.test(camel)) return `${camel.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(camel)) return `${camel}es`

  return `${camel}s`
}
