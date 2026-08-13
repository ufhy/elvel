import { Collection } from '@elysian/support'
import type { Row } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import type { ModelBuilder } from './builder.ts'
import { formatDateTime } from './casts.ts'
import { type Model, type ModelClass, Pivot } from './model.ts'

/**
 * A relation is a query plus the knowledge of how to attach its results to a
 * parent — the second half being what eager loading needs.
 */
export abstract class Relation<R extends Model> {
  constructor(
    protected readonly related: ModelClass<R>,
    protected readonly parent: Model
  ) {}

  /** A query for this relation, constrained to the parent. */
  abstract query(): ModelBuilder<R>

  /** Fetch the relation for a single parent. */
  abstract get(): Promise<Collection<R> | R | undefined>

  /**
   * Load this relation for many parents with one extra query, then match the
   * results back by key. Parents whose key is null are skipped: matching them
   * against a null foreign key would attach unrelated rows.
   */
  abstract eagerLoad(models: Model[], name: string): Promise<void>

  /**
   * How to correlate this relation in a subquery, which is what `whereHas` and
   * `withCount` need: the child table, and the two columns that join it to the
   * parent.
   */
  abstract existsConstraint(parentTable: string): {
    table: string
    foreign: string
    local: string
    related: ModelClass<R>
  }

  protected keysOf(models: Model[], key: string): unknown[] {
    const keys = new Set<unknown>()

    for (const model of models) {
      const value = model.attributes[key]
      if (value !== null && value !== undefined) keys.add(value)
    }

    return [...keys]
  }

  /** Dictionary of rows grouped by a foreign key, as `buildDictionary` does. */
  protected dictionary(models: R[], key: string): Map<string, R[]> {
    const grouped = new Map<string, R[]>()

    for (const model of models) {
      const value = model.attributes[key]
      if (value === null || value === undefined) continue

      const id = String(value)
      const bucket = grouped.get(id) ?? []
      bucket.push(model)
      grouped.set(id, bucket)
    }

    return grouped
  }
}

/**
 * Shared behaviour for the two "parent owns the key" relations.
 *
 * `HasOne` cannot simply extend `HasMany`: narrowing `get()` from a collection
 * to a single model would break the base class contract.
 */
export abstract class HasOneOrMany<R extends Model> extends Relation<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    protected readonly foreignKey: string,
    protected readonly localKey: string
  ) {
    super(related, parent)
  }

  query(): ModelBuilder<R> {
    return (this.related as typeof Model)
      .query()
      .where(this.foreignKey, this.parent.attributes[this.localKey]) as ModelBuilder<R>
  }

  /** Create a child already pointing at this parent. */
  async create(attributes: Row): Promise<R> {
    return (this.related as typeof Model).create({
      ...attributes,
      [this.foreignKey]: this.parent.attributes[this.localKey]
    }) as Promise<R>
  }

  async count(): Promise<number> {
    return this.query().count()
  }

  existsConstraint(parentTable: string) {
    return {
      table: (this.related as typeof Model).getTable(),
      foreign: `${(this.related as typeof Model).getTable()}.${this.foreignKey}`,
      local: `${parentTable}.${this.localKey}`,
      related: this.related
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.localKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, new Collection<R>([]))
      return
    }

    const children = await ((this.related as typeof Model).query() as ModelBuilder<R>)
      .whereIn(this.foreignKey, keys)
      .get()

    const grouped = this.dictionary(children.all(), this.foreignKey)

    for (const model of models) {
      const key = model.attributes[this.localKey]
      const matched = key === null || key === undefined ? [] : (grouped.get(String(key)) ?? [])

      model.setRelation(name, new Collection(matched))
    }
  }
}

/** `user.posts()` — many children pointing back at one parent. */
export class HasMany<R extends Model> extends HasOneOrMany<R> {
  async get(): Promise<Collection<R>> {
    return this.query().get()
  }
}

/** `user.profile()` — the one-child case, which returns a model, not a list. */
export class HasOne<R extends Model> extends HasOneOrMany<R> {
  async get(): Promise<R | undefined> {
    return this.query().first()
  }

  override async eagerLoad(models: Model[], name: string): Promise<void> {
    await super.eagerLoad(models, name)

    // Collapse each collection to its first member, as matchOne does.
    for (const model of models) {
      const value = model.getRelation(name)

      model.setRelation(name, value instanceof Collection ? value.first() : value)
    }
  }
}

/** `post.author()` — the child holds the key. */
export class BelongsTo<R extends Model> extends Relation<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    private readonly foreignKey: string,
    private readonly ownerKey: string
  ) {
    super(related, parent)
  }

  query(): ModelBuilder<R> {
    return (this.related as typeof Model)
      .query()
      .where(this.ownerKey, this.parent.attributes[this.foreignKey]) as ModelBuilder<R>
  }

  async get(): Promise<R | undefined> {
    if (this.parent.attributes[this.foreignKey] == null) return undefined

    return this.query().first()
  }

  /** Point the child at a parent, without saving. */
  associate(model: R): Model {
    return this.parent.setAttribute(this.foreignKey, model.attributes[this.ownerKey])
  }

  dissociate(): Model {
    return this.parent.setAttribute(this.foreignKey, null)
  }

  existsConstraint(parentTable: string) {
    return {
      table: (this.related as typeof Model).getTable(),
      foreign: `${(this.related as typeof Model).getTable()}.${this.ownerKey}`,
      local: `${parentTable}.${this.foreignKey}`,
      related: this.related
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.foreignKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, undefined)
      return
    }

    const owners = await ((this.related as typeof Model).query() as ModelBuilder<R>)
      .whereIn(this.ownerKey, keys)
      .get()

    const byKey = new Map<string, R>()
    for (const owner of owners.all()) {
      const value = owner.attributes[this.ownerKey]
      if (value !== null && value !== undefined) byKey.set(String(value), owner)
    }

    for (const model of models) {
      const key = model.attributes[this.foreignKey]

      model.setRelation(
        name,
        key === null || key === undefined ? undefined : byKey.get(String(key))
      )
    }
  }
}

/** `post.tags()` — many-to-many through a pivot table. */
export class BelongsToMany<R extends Model> extends Relation<R> {
  /** Extra pivot columns to read back, beyond the two keys. */
  protected pivotColumns: string[] = []
  /** Constraints on the pivot table itself, as `wherePivot()` adds them. */
  protected pivotWheres: Array<[string, unknown]> = []
  /** Values written on every attach — how a morph pivot stores its type. */
  protected pivotValues: Record<string, unknown> = {}
  protected pivotAccessor = 'pivot'
  protected pivotModel?: typeof Pivot
  protected timestampColumns?: { createdAt: string; updatedAt: string }

  constructor(
    related: ModelClass<R>,
    parent: Model,
    protected readonly pivotTable: string,
    protected readonly foreignPivotKey: string,
    protected readonly relatedPivotKey: string,
    protected readonly parentKey = 'id',
    protected readonly relatedKey = 'id'
  ) {
    super(related, parent)
  }

  /**
   * Read these pivot columns back with the related models.
   *
   * They arrive aliased as `pivot_<column>` and are moved onto the accessor after
   * hydration — Laravel's approach, and the reason a pivot's `created_at` cannot
   * overwrite the related model's own.
   */
  withPivot(...columns: Array<string | string[]>): this {
    this.pivotColumns.push(...columns.flat())

    return this
  }

  /**
   * Maintain `created_at`/`updated_at` on the pivot rows.
   *
   * In Laravel this is `withPivot` plus writing them on attach, and it is the same
   * here: the columns have to be read back for `pivot.created_at` to exist at all.
   */
  withTimestamps(createdAt = 'created_at', updatedAt = 'updated_at'): this {
    this.timestampColumns = { createdAt, updatedAt }

    return this.withPivot(createdAt, updatedAt)
  }

  /** Hydrate the pivot as this model rather than a plain `Pivot`. */
  using(pivot: typeof Pivot): this {
    this.pivotModel = pivot

    return this
  }

  /** Call the pivot something else — `->as('membership')`. */
  as(accessor: string): this {
    this.pivotAccessor = accessor

    return this
  }

  /** Constrain by a pivot column, which a `where()` on the related cannot. */
  wherePivot(column: string, value: unknown): this {
    this.pivotWheres.push([column, value])

    return this
  }

  /** Constrain by a pivot column *and* write it on every attach. */
  withPivotValue(column: string, value: unknown): this {
    this.pivotValues[column] = value

    return this.withPivot(column).wherePivot(column, value)
  }

  query(): ModelBuilder<R> {
    const relatedTable = (this.related as typeof Model).getTable()

    const builder = ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(`${relatedTable}.*`, ...this.aliasedPivotColumns())
      .join(
        this.pivotTable,
        `${this.pivotTable}.${this.relatedPivotKey}`,
        '=',
        `${relatedTable}.${this.relatedKey}`
      )
      .where(
        `${this.pivotTable}.${this.foreignPivotKey}`,
        this.parent.attributes[this.parentKey]
      ) as ModelBuilder<R>

    for (const [column, value] of this.pivotWheres) {
      builder.where(`${this.pivotTable}.${column}`, value)
    }

    return builder
  }

  async get(): Promise<Collection<R>> {
    const models = await this.query().get()

    for (const model of models.all()) this.hydratePivot(model)

    return models
  }

  /**
   * `pivot_<column>` for every column worth reading back.
   *
   * The two keys are always included, because a pivot with neither is not much
   * of a pivot — and `pivot.user_id` is what a caller reaches for first.
   */
  protected aliasedPivotColumns(): string[] {
    const columns = [this.foreignPivotKey, this.relatedPivotKey, ...this.pivotColumns]

    return [...new Set(columns)].map((column) => `${this.pivotTable}.${column} as pivot_${column}`)
  }

  /** Move the `pivot_*` attributes onto the accessor, and off the model. */
  protected hydratePivot(model: Model): void {
    const values: Row = {}

    for (const [key, value] of Object.entries(model.attributes)) {
      if (!key.startsWith('pivot_')) continue

      values[key.slice('pivot_'.length)] = value
      delete model.attributes[key]
    }

    model.syncOriginal()

    const pivot = (this.pivotModel ?? Pivot).fromAttributes(
      values,
      this.pivotTable,
      this.foreignPivotKey,
      this.relatedPivotKey
    )

    model.setRelation(this.pivotAccessor, pivot)
  }

  /** Insert pivot rows, ignoring pairs that already exist. */
  async attach(ids: unknown | unknown[], attributes: Row = {}): Promise<void> {
    const now = new Date()

    const values = (Array.isArray(ids) ? ids : [ids]).map((id) => ({
      [this.foreignPivotKey]: this.parent.attributes[this.parentKey],
      [this.relatedPivotKey]: id,
      ...this.pivotValues,
      ...this.timestampsFor(now, true),
      ...attributes
    }))

    if (values.length === 0) return

    const query = await ((this.related as typeof Model).query() as ModelBuilder<R>).base()
    await query.clone().from(this.pivotTable).insertOrIgnore(values)
  }

  /** `created_at`/`updated_at` for a write, when the relation asked for them. */
  protected timestampsFor(now: Date, creating: boolean): Row {
    if (!this.timestampColumns) return {}

    const stamp = formatDateTime(now)

    return creating
      ? { [this.timestampColumns.createdAt]: stamp, [this.timestampColumns.updatedAt]: stamp }
      : { [this.timestampColumns.updatedAt]: stamp }
  }

  async detach(ids?: unknown | unknown[]): Promise<number> {
    const pivot = await this.pivotQuery()

    if (ids !== undefined) {
      pivot.whereIn(this.relatedPivotKey, Array.isArray(ids) ? ids : [ids])
    }

    return pivot.delete()
  }

  /** Make the pivot rows exactly `ids`. */
  async sync(ids: unknown[]): Promise<void> {
    await this.detach()
    await this.attach(ids)
  }

  /** Attach what is missing, leaving existing rows alone. */
  async syncWithoutDetaching(ids: unknown[]): Promise<void> {
    await this.attach(ids)
  }

  /** Attach the missing ids and detach the present ones. */
  async toggle(ids: unknown | unknown[]): Promise<void> {
    const wanted = Array.isArray(ids) ? ids : [ids]
    const current = new Set((await this.pivotIds()).map(String))

    const toAttach = wanted.filter((id) => !current.has(String(id)))
    const toDetach = wanted.filter((id) => current.has(String(id)))

    if (toDetach.length > 0) await this.detach(toDetach)
    if (toAttach.length > 0) await this.attach(toAttach)
  }

  /** Update extra columns on one pivot row. */
  async updateExistingPivot(id: unknown, values: Row): Promise<number> {
    const pivot = await this.pivotQuery()

    return pivot
      .where(this.relatedPivotKey, id)
      .update({ ...values, ...this.timestampsFor(new Date(), false) })
  }

  /** The related ids currently attached. */
  async pivotIds(): Promise<unknown[]> {
    const pivot = await this.pivotQuery()

    return (await pivot.pluck(this.relatedPivotKey)).all()
  }

  protected async pivotQuery(): Promise<QueryBuilder<Row>> {
    const query = await ((this.related as typeof Model).query() as ModelBuilder<R>).base()

    const pivot = query
      .clone()
      .from(this.pivotTable)
      .where(this.foreignPivotKey, this.parent.attributes[this.parentKey])

    // A morph pivot lives in a table shared by several parents, so every write and
    // every read has to carry the type as well as the key.
    for (const [column, value] of this.pivotWheres) pivot.where(column, value)

    return pivot
  }

  existsConstraint(parentTable: string) {
    // The pivot is the correlated table: a parent "has" the relation when a
    // pivot row exists, regardless of whether the related row still does.
    return {
      table: this.pivotTable,
      foreign: `${this.pivotTable}.${this.foreignPivotKey}`,
      local: `${parentTable}.${this.parentKey}`,
      related: this.related
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.parentKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, new Collection<R>([]))
      return
    }

    const relatedTable = (this.related as typeof Model).getTable()

    // The pivot's parent key is selected alongside the related columns so the
    // dictionary can be built without a second round trip.
    const eager = ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(
        `${relatedTable}.*`,
        `${this.pivotTable}.${this.foreignPivotKey} as pivot_parent_key`,
        ...this.aliasedPivotColumns()
      )
      .join(
        this.pivotTable,
        `${this.pivotTable}.${this.relatedPivotKey}`,
        '=',
        `${relatedTable}.${this.relatedKey}`
      )
      .whereIn(`${this.pivotTable}.${this.foreignPivotKey}`, keys)

    // The same constraints the lazy path applies, or an eager load would return
    // rows a `->get()` on the same relation refuses — including a morph's type.
    for (const [column, value] of this.pivotWheres) {
      eager.where(`${this.pivotTable}.${column}`, value)
    }

    const rows = await eager.get()

    const grouped = new Map<string, R[]>()

    for (const row of rows.all()) {
      const pivotKey = row.attributes.pivot_parent_key
      delete row.attributes.pivot_parent_key

      // Before syncOriginal: hydratePivot moves the `pivot_*` attributes off the
      // model, and an original that still held them would report every eagerly
      // loaded model as dirty.
      this.hydratePivot(row)

      if (pivotKey === null || pivotKey === undefined) continue

      const bucket = grouped.get(String(pivotKey)) ?? []
      bucket.push(row)
      grouped.set(String(pivotKey), bucket)
    }

    for (const model of models) {
      const key = model.attributes[this.parentKey]

      model.setRelation(
        name,
        new Collection(key === null || key === undefined ? [] : (grouped.get(String(key)) ?? []))
      )
    }
  }
}

/**
 * `post.tags()` and `tag.posts()` — a many-to-many where one side is polymorphic.
 *
 * `BelongsToMany` with one more pivot column: `<name>_type`. What decides its
 * value is the **direction**, and that is the whole subtlety:
 *
 * - `morphToMany` is the owner side (`post.tags()`), so the pivot stores the
 *   *parent's* type — `posts`.
 * - `morphedByMany` is the inverse (`tag.posts()`), so it stores the *related*
 *   model's type, because that is what the rows on the other side are.
 *
 * Getting that backwards produces a relation that silently returns nothing, which
 * is why the constructor takes the flag rather than leaving it to the caller.
 */
export class MorphToMany<R extends Model> extends BelongsToMany<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    name: string,
    pivotTable: string,
    foreignPivotKey: string,
    relatedPivotKey: string,
    morphType: string,
    parentKey = 'id',
    relatedKey = 'id'
  ) {
    super(related, parent, pivotTable, foreignPivotKey, relatedPivotKey, parentKey, relatedKey)

    // Constrains reads *and* is written on every attach, so a pivot row can never
    // be created without the type that makes it findable again.
    this.withPivotValue(`${name}_type`, morphType)
  }
}

/**
 * `comment.commentable()` — the child stores both a key and a type.
 *
 * A morph is the one relation that cannot be eager-loaded in a single query:
 * the rows point at different tables, so one query per distinct type is the
 * floor, not a shortcoming of the implementation.
 */
export class MorphTo extends Relation<Model> {
  constructor(
    parent: Model,
    private readonly morphName: string,
    private readonly types: Record<string, ModelClass<Model>>,
    private readonly typeColumn = `${morphName}_type`,
    private readonly idColumn = `${morphName}_id`
  ) {
    // There is no single related class; resolution happens per row.
    super(undefined as unknown as ModelClass<Model>, parent)
  }

  private classFor(type: unknown): ModelClass<Model> | undefined {
    return typeof type === 'string' ? this.types[type] : undefined
  }

  query(): ModelBuilder<Model> {
    const related = this.classFor(this.parent.attributes[this.typeColumn])

    if (!related) {
      throw new Error(
        `Unknown morph type [${String(this.parent.attributes[this.typeColumn])}] for ${this.morphName}.`
      )
    }

    return (related as typeof Model)
      .query()
      .where((related as typeof Model).primaryKey, this.parent.attributes[this.idColumn])
  }

  async get(): Promise<Model | undefined> {
    if (this.parent.attributes[this.idColumn] == null) return undefined

    return this.query().first()
  }

  existsConstraint(): never {
    // `whereHas` on a morphTo would have to union across every type table.
    throw new Error('whereHas/withCount are not supported on a morphTo relation.')
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const byType = new Map<string, Model[]>()

    for (const model of models) {
      const type = model.attributes[this.typeColumn]
      const id = model.attributes[this.idColumn]
      if (typeof type !== 'string' || id === null || id === undefined) {
        model.setRelation(name, undefined)
        continue
      }

      const bucket = byType.get(type) ?? []
      bucket.push(model)
      byType.set(type, bucket)
    }

    // One query per distinct type, rather than one per row.
    for (const [type, group] of byType) {
      const related = this.classFor(type)

      if (!related) {
        for (const model of group) model.setRelation(name, undefined)
        continue
      }

      const key = (related as typeof Model).primaryKey
      const owners = await (related as typeof Model)
        .query()
        .whereIn(key, this.keysOf(group, this.idColumn))
        .get()

      const byKey = new Map<string, Model>()
      for (const owner of owners.all()) byKey.set(String(owner.attributes[key]), owner)

      for (const model of group) {
        model.setRelation(name, byKey.get(String(model.attributes[this.idColumn])))
      }
    }
  }
}

/** Shared behaviour for the one- and many-child morph relations. */
export abstract class MorphOneOrMany<R extends Model> extends Relation<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    private readonly morphName: string,
    private readonly morphType: string,
    private readonly localKey = 'id'
  ) {
    super(related, parent)
  }

  private get typeColumn(): string {
    return `${this.morphName}_type`
  }

  private get idColumn(): string {
    return `${this.morphName}_id`
  }

  query(): ModelBuilder<R> {
    return ((this.related as typeof Model).query() as ModelBuilder<R>)
      .where(this.typeColumn, this.morphType)
      .where(this.idColumn, this.parent.attributes[this.localKey])
  }

  async create(attributes: Row): Promise<R> {
    return (this.related as typeof Model).create({
      ...attributes,
      [this.typeColumn]: this.morphType,
      [this.idColumn]: this.parent.attributes[this.localKey]
    }) as Promise<R>
  }

  existsConstraint(parentTable: string) {
    const table = (this.related as typeof Model).getTable()

    return {
      table,
      foreign: `${table}.${this.idColumn}`,
      local: `${parentTable}.${this.localKey}`,
      related: this.related
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.localKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, new Collection<R>([]))
      return
    }

    const children = await ((this.related as typeof Model).query() as ModelBuilder<R>)
      .where(this.typeColumn, this.morphType)
      .whereIn(this.idColumn, keys)
      .get()

    const grouped = this.dictionary(children.all(), this.idColumn)

    for (const model of models) {
      const key = model.attributes[this.localKey]

      model.setRelation(
        name,
        new Collection(key === null || key === undefined ? [] : (grouped.get(String(key)) ?? []))
      )
    }
  }
}

/** `post.comments()` where the child stores `commentable_type` + `commentable_id`. */
export class MorphMany<R extends Model> extends MorphOneOrMany<R> {
  async get(): Promise<Collection<R>> {
    return this.query().get()
  }
}

/** The single-child morph. */
export class MorphOne<R extends Model> extends MorphOneOrMany<R> {
  async get(): Promise<R | undefined> {
    return this.query().first()
  }

  override async eagerLoad(models: Model[], name: string): Promise<void> {
    await super.eagerLoad(models, name)

    for (const model of models) {
      const value = model.getRelation(name)
      model.setRelation(name, value instanceof Collection ? value.first() : value)
    }
  }
}

/**
 * `country.posts()` — reach a grandchild through an intermediate table.
 *
 * Laravel's `hasManyThrough`. The join is explicit rather than inferred so the
 * SQL stays inspectable.
 */
export class HasManyThrough<R extends Model> extends Relation<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    protected readonly through: ModelClass<Model>,
    protected readonly firstKey: string,
    protected readonly secondKey: string,
    protected readonly localKey = 'id',
    protected readonly secondLocalKey = 'id'
  ) {
    super(related, parent)
  }

  protected get throughTable(): string {
    return (this.through as typeof Model).getTable()
  }

  protected get relatedTable(): string {
    return (this.related as typeof Model).getTable()
  }

  query(): ModelBuilder<R> {
    return ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(`${this.relatedTable}.*`)
      .join(
        this.throughTable,
        `${this.throughTable}.${this.secondLocalKey}`,
        '=',
        `${this.relatedTable}.${this.secondKey}`
      )
      .where(`${this.throughTable}.${this.firstKey}`, this.parent.attributes[this.localKey])
  }

  async get(): Promise<Collection<R>> {
    return this.query().get()
  }

  existsConstraint(parentTable: string) {
    // Correlate on the intermediate table: the grandchild alone cannot reach the
    // parent's key.
    return {
      table: this.throughTable,
      foreign: `${this.throughTable}.${this.firstKey}`,
      local: `${parentTable}.${this.localKey}`,
      related: this.through as unknown as ModelClass<R>
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.localKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, new Collection<R>([]))
      return
    }

    const rows = await ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(
        `${this.relatedTable}.*`,
        `${this.throughTable}.${this.firstKey} as through_parent_key`
      )
      .join(
        this.throughTable,
        `${this.throughTable}.${this.secondLocalKey}`,
        '=',
        `${this.relatedTable}.${this.secondKey}`
      )
      .whereIn(`${this.throughTable}.${this.firstKey}`, keys)
      .get()

    const grouped = new Map<string, R[]>()

    for (const row of rows.all()) {
      const key = row.attributes.through_parent_key
      delete row.attributes.through_parent_key
      row.syncOriginal()

      if (key === null || key === undefined) continue

      const bucket = grouped.get(String(key)) ?? []
      bucket.push(row)
      grouped.set(String(key), bucket)
    }

    for (const model of models) {
      const key = model.attributes[this.localKey]

      model.setRelation(
        name,
        new Collection(key === null || key === undefined ? [] : (grouped.get(String(key)) ?? []))
      )
    }
  }
}

/**
 * `country.latestPost()` — one row across an intermediate table.
 *
 * `HasManyThrough` with `first()` instead of `get()`, which is exactly what
 * Laravel does. The eager load is where it differs: the query still fetches every
 * child, and the *first per parent* is kept — a `limit 1` would return one row for
 * the whole set rather than one per parent, which is the classic way to get this
 * wrong.
 */
export class HasOneThrough<R extends Model> extends HasManyThrough<R> {
  async getOne(): Promise<R | undefined> {
    return this.query().first()
  }

  override async eagerLoad(models: Model[], name: string): Promise<void> {
    // Reuse the many version, then narrow: the dictionary it builds is grouped by
    // parent already, so the first of each group is the answer.
    await super.eagerLoad(models, name)

    for (const model of models) {
      const loaded = model.getRelation(name) as Collection<R> | undefined

      model.setRelation(name, loaded?.first())
    }
  }
}

/**
 * `user.latestPost()` — the newest child of a one-to-many.
 *
 * Transcribed from `CanBeOneOfMany`: a grouped subquery selects the aggregate per
 * parent, and the relation joins back on it. The obvious alternative —
 * `orderBy(column, 'desc').limit(1)` — is correct for one parent and wrong for an
 * eager load, where it returns a single row for the entire set.
 *
 * The key is aggregated alongside the column, and joined on as well, because two
 * rows can share a `created_at`: without it the join matches both and the "one"
 * relation quietly returns two.
 */
export class HasOneOfMany<R extends Model> extends Relation<R> {
  constructor(
    related: ModelClass<R>,
    parent: Model,
    private readonly foreignKey: string,
    private readonly column: string,
    private readonly aggregate: 'max' | 'min',
    private readonly localKey = 'id'
  ) {
    super(related, parent)
  }

  private get relatedTable(): string {
    return (this.related as typeof Model).getTable()
  }

  private get keyName(): string {
    return (this.related as typeof Model).primaryKey
  }

  /** The alias the subquery is joined under. */
  private get alias(): string {
    return `${this.relatedTable}_of_many`
  }

  query(): ModelBuilder<R> {
    return this.constrain(
      ((this.related as typeof Model).query() as ModelBuilder<R>).where(
        `${this.relatedTable}.${this.foreignKey}`,
        this.parent.attributes[this.localKey]
      )
    )
  }

  /** Join the per-parent aggregate, whatever the outer query is filtered by. */
  private constrain(builder: ModelBuilder<R>): ModelBuilder<R> {
    return builder.deferBase((query) => {
      const connection = query.connection
      const sub = new QueryBuilder<Row>(connection, this.relatedTable)
        .selectRaw(
          [
            `${this.aggregate}(${connection.grammar.wrap(`${this.relatedTable}.${this.column}`)}) as ${connection.grammar.wrap(`${this.column}_aggregate`)}`,
            // The key breaks a tie on the column, and is aggregated the same way
            // so the two always describe the same row.
            `${this.aggregate}(${connection.grammar.wrap(`${this.relatedTable}.${this.keyName}`)}) as ${connection.grammar.wrap(`${this.keyName}_aggregate`)}`,
            connection.grammar.wrap(`${this.relatedTable}.${this.foreignKey}`)
          ].join(', ')
        )
        .groupBy(`${this.relatedTable}.${this.foreignKey}`)

      query
        .joinSub(
          sub,
          this.alias,
          `${this.alias}.${this.keyName}_aggregate`,
          '=',
          `${this.relatedTable}.${this.keyName}`
        )
        .whereColumn(
          `${this.alias}.${this.foreignKey}`,
          '=',
          `${this.relatedTable}.${this.foreignKey}`
        )
    })
  }

  async getOne(): Promise<R | undefined> {
    return this.query().first()
  }

  async get(): Promise<Collection<R>> {
    return this.query().get()
  }

  existsConstraint(parentTable: string) {
    const table = this.relatedTable

    return {
      table,
      foreign: `${table}.${this.foreignKey}`,
      local: `${parentTable}.${this.localKey}`,
      related: this.related
    }
  }

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.localKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, undefined)

      return
    }

    // One query for every parent, and the join keeps it to one row each — which is
    // the entire reason for the subquery.
    const rows = await this.constrain(
      ((this.related as typeof Model).query() as ModelBuilder<R>).whereIn(
        `${this.relatedTable}.${this.foreignKey}`,
        keys
      )
    ).get()

    const byParent = new Map<string, R>()

    for (const row of rows.all()) {
      byParent.set(String(row.attributes[this.foreignKey]), row)
    }

    for (const model of models) {
      const key = model.attributes[this.localKey]

      model.setRelation(
        name,
        key === null || key === undefined ? undefined : byParent.get(String(key))
      )
    }
  }
}
