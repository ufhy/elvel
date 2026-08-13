import type { EventDispatcher } from '@elysian/contracts'
import { Collection } from '@elysian/support'
import type { Connection, Row } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import { ModelBuilder } from './builder.ts'
import { type CastType, castFromDatabase, castToDatabase, formatDateTime } from './casts.ts'
import {
  BelongsTo,
  BelongsToMany,
  HasMany,
  HasManyThrough,
  HasOne,
  HasOneOfMany,
  HasOneThrough,
  MorphMany,
  MorphOne,
  MorphTo,
  MorphToMany,
  type Relation
} from './relations.ts'

export type ConnectionResolver = (name?: string) => Promise<Connection>

export type ModelClass<M extends Model = Model> = typeof Model & {
  new (attributes?: Row): M
}

/** Lifecycle events, dispatched when the events package is available. */
export class ModelEvent {
  constructor(
    readonly name: string,
    readonly model: Model
  ) {}

  static readonly eventName = 'model'
}

/**
 * Base model.
 *
 * Attribute access goes through a Proxy, so `user.name` reads an attribute while
 * `user.save()` stays a method. Declare your columns with `declare` so they are
 * typed without shadowing the proxy at runtime:
 *
 * ```ts
 * class User extends Model {
 *   static override table = 'users'
 *   declare id: number
 *   declare name: string
 *
 *   posts() { return this.hasMany(Post) }
 * }
 * ```
 *
 * There is no synchronous lazy loading. `$user->posts` cannot work on Bun,
 * because reaching the database is asynchronous — so relations are methods and
 * you `await user.posts().get()`. Eager loading via `with()` is what keeps that
 * from becoming an N+1.
 */
export class Model {
  static table?: string
  static primaryKey = 'id'
  static incrementing = true
  static keyType: 'int' | 'string' = 'int'
  static timestamps = true
  static connection?: string

  /** Columns mass assignment accepts. Empty means "consult `guarded`". */
  static fillable: string[] = []

  /** Columns mass assignment refuses. `['*']` blocks everything, as Laravel does. */
  static guarded: string[] = ['*']

  static casts: Record<string, CastType> = {}

  /** Columns removed from `toObject()`/`toJSON()`. */
  static hidden: string[] = []

  /** Accessor-backed keys added to `toObject()` — Laravel's `$appends`. */
  static appends: string[] = []

  /** Scopes applied to every query for this model. */
  static globalScopes: Record<string, (query: ModelBuilder<Model>) => void> = {}

  static softDeletes = false

  static CREATED_AT = 'created_at'
  static UPDATED_AT = 'updated_at'
  static DELETED_AT = 'deleted_at'

  private static resolver?: ConnectionResolver
  private static dispatcher?: EventDispatcher

  /** Wired by DatabaseServiceProvider; set by hand in tests. */
  static setConnectionResolver(resolver: ConnectionResolver): void {
    Model.resolver = resolver
  }

  static setEventDispatcher(dispatcher: EventDispatcher | undefined): void {
    Model.dispatcher = dispatcher
  }

  static getConnection(name?: string): Promise<Connection> {
    if (!Model.resolver) {
      throw new Error(
        'No connection resolver. Register DatabaseServiceProvider, or call Model.setConnectionResolver().'
      )
    }

    return Model.resolver(name)
  }

  attributes: Row = {}
  original: Row = {}
  /** Set by the last successful save, so `wasChanged()` can answer. */
  private changes: Row = {}
  relations: Record<string, unknown> = {}
  exists = false

  constructor(attributes: Row = {}) {
    this.fill(attributes)

    // A Proxy is what lets `user.name` work while `user.save()` still resolves.
    // Returning it from the constructor keeps `instanceof` intact.
    // biome-ignore lint/correctness/noConstructorReturn: the proxy IS the model
    return new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property !== 'string' || property in target) {
          return Reflect.get(target, property, receiver)
        }

        if (property in target.relations) return target.relations[property]
        if (property in target.attributes) return target.getAttribute(property)

        // An accessor may back a key that has no column at all.
        if (target.hasAccessor(property)) return target.getAttribute(property)

        return undefined
      },

      set(target, property, value, receiver) {
        if (typeof property !== 'string' || property in target) {
          return Reflect.set(target, property, value, receiver)
        }

        target.setAttribute(property, value)
        return true
      },

      has(target, property) {
        return (
          Reflect.has(target, property) ||
          (typeof property === 'string' &&
            (property in target.attributes || target.hasAccessor(property)))
        )
      },

      deleteProperty(target, property) {
        if (typeof property === 'string' && property in target.attributes) {
          delete target.attributes[property]
          return true
        }

        return Reflect.deleteProperty(target, property)
      },

      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), ...Object.keys(target.attributes)])]
      },

      getOwnPropertyDescriptor(target, property) {
        if (typeof property === 'string' && property in target.attributes) {
          return { configurable: true, enumerable: true, value: target.getAttribute(property) }
        }

        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })
  }

  // ------------------------------------------------------------------ statics

  private get self(): typeof Model {
    return this.constructor as typeof Model
  }

  /**
   * Are model events muted right now?
   *
   * A flag rather than swapping the dispatcher for a null one, which is Laravel's
   * approach: the dispatcher here is shared with the rest of the framework, and
   * replacing it would silence a listener that has nothing to do with models.
   */
  private static muted = false

  /**
   * Run `body` with model events silenced — `Model::withoutEvents`.
   *
   * A seeder or a migration that fires `created` for ten thousand rows is doing
   * work nobody asked for; more importantly a listener may dispatch a job, and a
   * backfill should not.
   *
   * Restored in a `finally`, so a throw inside the callback cannot leave the whole
   * application muted — the failure mode that makes this worth writing carefully.
   */
  static async withoutEvents<T>(body: () => T | Promise<T>): Promise<T> {
    const wasMuted = Model.muted
    Model.muted = true

    try {
      return await body()
    } finally {
      Model.muted = wasMuted
    }
  }

  /** Save without firing `saving`/`saved`/`created`/`updated`. */
  async saveQuietly(): Promise<boolean> {
    return Model.withoutEvents(() => this.save())
  }

  /** Delete without firing `deleting`/`deleted`. */
  async deleteQuietly(): Promise<boolean> {
    return Model.withoutEvents(() => this.delete())
  }

  /** `users` from `User`, unless `static table` says otherwise. */
  static getTable(): string {
    if (this.table) return this.table

    // Naive pluralisation, matching what Str.plural does for common cases.
    const base = this.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

    if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`
    if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`

    return `${base}s`
  }

  static query<T extends typeof Model>(this: T): ModelBuilder<InstanceType<T>> {
    return new ModelBuilder<InstanceType<T>>(this as unknown as ModelClass<InstanceType<T>>)
  }

  static async all<T extends typeof Model>(this: T): Promise<Collection<InstanceType<T>>> {
    return this.query().get()
  }

  static async find<T extends typeof Model>(
    this: T,
    id: unknown
  ): Promise<InstanceType<T> | undefined> {
    return this.query().find(id)
  }

  static async findOrFail<T extends typeof Model>(this: T, id: unknown): Promise<InstanceType<T>> {
    return this.query().findOrFail(id)
  }

  static async first<T extends typeof Model>(this: T): Promise<InstanceType<T> | undefined> {
    return this.query().first()
  }

  // Spelled out rather than forwarded with Parameters<>, which collapses an
  // overloaded method to its last signature and would break where(col, value).
  static where<T extends typeof Model>(
    this: T,
    column: string,
    operator: string,
    value: unknown
  ): ModelBuilder<InstanceType<T>>
  static where<T extends typeof Model>(
    this: T,
    column: string,
    value: unknown
  ): ModelBuilder<InstanceType<T>>
  static where<T extends typeof Model>(this: T, ...args: unknown[]): ModelBuilder<InstanceType<T>> {
    const query = this.query()

    ;(query.where as (...rest: unknown[]) => unknown)(...args)

    return query
  }

  static with<T extends typeof Model>(
    this: T,
    ...relations: string[]
  ): ModelBuilder<InstanceType<T>> {
    return this.query().with(...relations)
  }

  static async create<T extends typeof Model>(this: T, attributes: Row): Promise<InstanceType<T>> {
    const model = new this(attributes) as InstanceType<T>
    await model.save()

    return model
  }

  /** Build an instance from a database row, without marking it dirty. */
  static hydrate<T extends typeof Model>(this: T, row: Row): InstanceType<T> {
    const model = new this() as InstanceType<T>

    model.attributes = { ...row }
    model.syncOriginal()
    model.exists = true

    return model
  }

  static withTrashed<T extends typeof Model>(this: T): ModelBuilder<InstanceType<T>> {
    return this.query().withTrashed()
  }

  static onlyTrashed<T extends typeof Model>(this: T): ModelBuilder<InstanceType<T>> {
    return this.query().onlyTrashed()
  }

  /** Register a constraint applied to every query — Laravel's global scopes. */
  static addGlobalScope(name: string, scope: (query: ModelBuilder<never>) => void): void {
    // Copied rather than mutated so a subclass cannot alter its parent's scopes.
    this.globalScopes = { ...this.globalScopes, [name]: scope as never }
  }

  // --------------------------------------------------------------- attributes

  getKey(): unknown {
    return this.attributes[this.self.primaryKey]
  }

  getAttribute(key: string): unknown {
    // An accessor wins over the raw column: `getFullNameAttribute()` backs
    // `user.full_name`, including for keys with no column at all.
    const accessor = this.accessorFor(key)
    if (accessor) return accessor.call(this, this.attributes[key])

    const value = this.attributes[key]
    const cast = this.self.casts[key]

    if (cast) return castFromDatabase(value, cast)

    // Timestamps are dates even without an explicit cast, as in Laravel.
    if (this.isDateColumn(key) && value !== null && value !== undefined) {
      return castFromDatabase(value, 'datetime')
    }

    return value
  }

  setAttribute(key: string, value: unknown): this {
    const mutator = this.mutatorFor(key)
    if (mutator) {
      mutator.call(this, value)
      return this
    }

    const cast = this.self.casts[key]

    this.attributes[key] = cast
      ? castToDatabase(value, cast)
      : value instanceof Date
        ? formatDateTime(value)
        : value

    return this
  }

  hasAccessor(key: string): boolean {
    return this.accessorFor(key) !== undefined
  }

  /** `full_name` -> `getFullNameAttribute` */
  private accessorFor(key: string): ((value: unknown) => unknown) | undefined {
    const method = `get${Model.studly(key)}Attribute`
    const candidate = (this as unknown as Record<string, unknown>)[method]

    return typeof candidate === 'function' ? (candidate as (value: unknown) => unknown) : undefined
  }

  private mutatorFor(key: string): ((value: unknown) => void) | undefined {
    const method = `set${Model.studly(key)}Attribute`
    const candidate = (this as unknown as Record<string, unknown>)[method]

    return typeof candidate === 'function' ? (candidate as (value: unknown) => void) : undefined
  }

  static studly(value: string): string {
    return value
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  }

  private isDateColumn(key: string): boolean {
    const dates = [this.self.CREATED_AT, this.self.UPDATED_AT]
    if (this.self.softDeletes) dates.push(this.self.DELETED_AT)

    return dates.includes(key)
  }

  /** Mass assignment, honouring `fillable`/`guarded`. */
  fill(attributes: Row): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (this.isFillable(key)) this.setAttribute(key, value)
    }

    return this
  }

  /** Assign regardless of `fillable`/`guarded` — Laravel's `forceFill`. */
  forceFill(attributes: Row): this {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value)

    return this
  }

  isFillable(key: string): boolean {
    if (this.self.fillable.length > 0) return this.self.fillable.includes(key)

    if (this.self.guarded.includes('*')) {
      // Guarded by default, but the framework's own columns must still fill.
      return [this.self.primaryKey, this.self.CREATED_AT, this.self.UPDATED_AT].includes(key)
        ? key !== this.self.primaryKey
        : false
    }

    return !this.self.guarded.includes(key)
  }

  // ------------------------------------------------------------------- dirty

  syncOriginal(): this {
    this.original = { ...this.attributes }
    return this
  }

  /**
   * Attributes that differ from the last sync.
   *
   * A key absent from `original` counts as dirty, which is what makes a newly
   * built model save every attribute it was given.
   */
  getDirty(): Row {
    const dirty: Row = {}

    for (const [key, value] of Object.entries(this.attributes)) {
      if (!(key in this.original)) {
        dirty[key] = value
        continue
      }

      if (!Model.equivalent(this.original[key], value)) dirty[key] = value
    }

    return dirty
  }

  isDirty(...keys: string[]): boolean {
    const dirty = this.getDirty()

    return keys.length === 0 ? Object.keys(dirty).length > 0 : keys.some((key) => key in dirty)
  }

  isClean(...keys: string[]): boolean {
    return !this.isDirty(...keys)
  }

  /** What the last save actually changed — Laravel's `getChanges`. */
  getChanges(): Row {
    return { ...this.changes }
  }

  wasChanged(...keys: string[]): boolean {
    return keys.length === 0
      ? Object.keys(this.changes).length > 0
      : keys.some((key) => key in this.changes)
  }

  /** The value a key held when it was last synced. */
  getOriginal(key?: string): unknown {
    return key === undefined ? { ...this.original } : this.original[key]
  }

  private static equivalent(original: unknown, current: unknown): boolean {
    if (original === current) return true
    if (original === null || current === null) return false

    if (typeof original === 'object' || typeof current === 'object') {
      return JSON.stringify(original) === JSON.stringify(current)
    }

    // A driver may return `1` where the caller set `'1'`; treat that as equal so
    // a round trip does not report a phantom change.
    return String(original) === String(current)
  }

  // ------------------------------------------------------------- persistence

  async newQuery(): Promise<ModelBuilder<this>> {
    return new ModelBuilder<this>(this.self as unknown as ModelClass<this>)
  }

  /**
   * A raw query builder for this model's table.
   *
   * Persistence bypasses ModelBuilder deliberately: it must not inherit the
   * soft-delete scope, and it needs the connection resolved, which is async.
   */
  private async baseQuery(): Promise<QueryBuilder<Row>> {
    const connection = await Model.getConnection(this.self.connection)

    // The *instance* decides the table. Almost always the class's, but a pivot
    // learns its table from the relation that built it, and saving one has to
    // reach that table rather than a guess made from the class name.
    return new QueryBuilder<Row>(connection, this.getTable())
  }

  /** This instance's table. Overridden by a pivot, which is told its own. */
  getTable(): string {
    return this.self.getTable()
  }

  async save(): Promise<boolean> {
    const query = await this.baseQuery()

    await this.fireEvent('saving')

    this.changes = this.getDirty()

    const saved = this.exists ? await this.performUpdate(query) : await this.performInsert(query)

    if (saved) {
      await this.fireEvent('saved')
      this.syncOriginal()
    }

    return saved
  }

  private async performUpdate(query: QueryBuilder<Row>): Promise<boolean> {
    const dirty = this.getDirty()

    // Nothing changed: skip the query entirely rather than issue a no-op UPDATE.
    if (Object.keys(dirty).length === 0) return true

    await this.fireEvent('updating')

    if (this.self.timestamps) {
      this.touchUpdatedAt()
      dirty[this.self.UPDATED_AT] = this.attributes[this.self.UPDATED_AT]
    }

    await query.clone().where(this.self.primaryKey, this.getKey()).update(dirty)

    await this.fireEvent('updated')

    return true
  }

  private async performInsert(query: QueryBuilder<Row>): Promise<boolean> {
    await this.fireEvent('creating')

    if (this.self.timestamps) {
      const now = formatDateTime(new Date())
      this.attributes[this.self.CREATED_AT] ??= now
      this.attributes[this.self.UPDATED_AT] ??= now
    }

    if (this.self.incrementing) {
      const id = await query.clone().insertGetId(this.attributes, this.self.primaryKey)
      this.attributes[this.self.primaryKey] = id
    } else {
      await query.clone().insert(this.attributes)
    }

    this.exists = true
    await this.fireEvent('created')

    return true
  }

  async update(attributes: Row): Promise<boolean> {
    if (!this.exists) return false

    this.fill(attributes)

    return this.save()
  }

  /** Set `updated_at` without touching anything else. */
  async touch(): Promise<boolean> {
    if (!this.self.timestamps) return false

    this.touchUpdatedAt()

    return this.save()
  }

  private touchUpdatedAt(): void {
    this.attributes[this.self.UPDATED_AT] = formatDateTime(new Date())
  }

  /** Run `callback` without touching `updated_at`. */
  async withoutTimestamps<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.self.timestamps

    // Static, so a concurrent save on another instance of the same model would
    // also skip timestamps; scope the callback tightly.
    ;(this.self as { timestamps: boolean }).timestamps = false

    try {
      return await callback()
    } finally {
      ;(this.self as { timestamps: boolean }).timestamps = previous
    }
  }

  /** An unsaved copy without the key or timestamps — Laravel's `replicate`. */
  replicate(except: string[] = []): this {
    const skip = new Set([
      this.self.primaryKey,
      this.self.CREATED_AT,
      this.self.UPDATED_AT,
      ...except
    ])

    const copy = new (this.constructor as new () => Model)() as this

    for (const [key, value] of Object.entries(this.attributes)) {
      if (!skip.has(key)) copy.attributes[key] = value
    }

    return copy
  }

  /** Same model and same key. */
  is(other: Model | undefined | null): boolean {
    return (
      other instanceof Model &&
      other.constructor === this.constructor &&
      other.getKey() === this.getKey() &&
      other.getKey() !== undefined
    )
  }

  isNot(other: Model | undefined | null): boolean {
    return !this.is(other)
  }

  /** Serialise only these attributes. */
  only(...keys: string[]): Row {
    const object = this.toObject()
    const result: Row = {}

    for (const key of keys.flat()) if (key in object) result[key] = object[key]

    return result
  }

  except(...keys: string[]): Row {
    const object = this.toObject()

    for (const key of keys.flat()) delete object[key]

    return object
  }

  async delete(): Promise<boolean> {
    if (!this.exists) return false

    await this.fireEvent('deleting')

    const query = (await this.baseQuery()).where(this.self.primaryKey, this.getKey())

    if (this.self.softDeletes) {
      const now = formatDateTime(new Date())
      await query.update({ [this.self.DELETED_AT]: now })
      this.attributes[this.self.DELETED_AT] = now
      this.syncOriginal()
    } else {
      await query.delete()
      this.exists = false
    }

    await this.fireEvent('deleted')

    return true
  }

  /** Delete for real, even when the model soft deletes. */
  async forceDelete(): Promise<boolean> {
    if (!this.exists) return false

    await this.fireEvent('deleting')
    await (await this.baseQuery()).where(this.self.primaryKey, this.getKey()).delete()

    this.exists = false
    await this.fireEvent('deleted')

    return true
  }

  async restore(): Promise<boolean> {
    if (!this.self.softDeletes) return false

    await (await this.baseQuery())
      .where(this.self.primaryKey, this.getKey())
      .update({ [this.self.DELETED_AT]: null })

    this.attributes[this.self.DELETED_AT] = null
    this.syncOriginal()

    return true
  }

  trashed(): boolean {
    return this.self.softDeletes && this.attributes[this.self.DELETED_AT] != null
  }

  /** Re-read this row from the database, leaving this instance untouched. */
  async fresh(): Promise<this | undefined> {
    if (!this.exists) return undefined

    const query = await this.newQuery()

    return (this.self.softDeletes ? query.withTrashed() : query).find(this.getKey()) as Promise<
      this | undefined
    >
  }

  /** Re-read this row into this instance, discarding unsaved changes. */
  async refresh(): Promise<this> {
    const fresh = await this.fresh()
    if (!fresh) return this

    this.attributes = { ...fresh.attributes }
    this.relations = {}
    this.syncOriginal()

    return this
  }

  // ------------------------------------------------------------------ relations

  hasMany<R extends Model>(
    related: ModelClass<R>,
    foreignKey?: string,
    localKey?: string
  ): HasMany<R> {
    return new HasMany(
      related,
      this,
      foreignKey ?? this.foreignKeyName(),
      localKey ?? this.self.primaryKey
    )
  }

  hasOne<R extends Model>(
    related: ModelClass<R>,
    foreignKey?: string,
    localKey?: string
  ): HasOne<R> {
    return new HasOne(
      related,
      this,
      foreignKey ?? this.foreignKeyName(),
      localKey ?? this.self.primaryKey
    )
  }

  belongsTo<R extends Model>(
    related: ModelClass<R>,
    foreignKey?: string,
    ownerKey?: string
  ): BelongsTo<R> {
    const resolvedForeign =
      foreignKey ?? `${Model.snake(related.name)}_${(related as typeof Model).primaryKey}`

    return new BelongsTo(related, this, resolvedForeign, ownerKey ?? related.primaryKey)
  }

  belongsToMany<R extends Model>(
    related: ModelClass<R>,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string
  ): BelongsToMany<R> {
    const tables = [Model.snake(this.self.name), Model.snake(related.name)].sort()

    return new BelongsToMany(
      related,
      this,
      pivotTable ?? tables.join('_'),
      foreignPivotKey ?? this.foreignKeyName(),
      relatedPivotKey ?? `${Model.snake(related.name)}_${related.primaryKey}`
    )
  }

  /**
   * `comment.commentable()` — the type map is explicit because a string in the
   * database cannot resolve to a class on its own.
   */
  morphTo(name: string, types: Record<string, ModelClass<Model>>): MorphTo {
    return new MorphTo(this, name, types)
  }

  morphMany<R extends Model>(
    related: ModelClass<R>,
    name: string,
    morphType = this.self.getTable()
  ): MorphMany<R> {
    return new MorphMany(related, this, name, morphType, this.self.primaryKey)
  }

  morphOne<R extends Model>(
    related: ModelClass<R>,
    name: string,
    morphType = this.self.getTable()
  ): MorphOne<R> {
    return new MorphOne(related, this, name, morphType, this.self.primaryKey)
  }

  /**
   * `post.tags()` — this model's side of a polymorphic many-to-many.
   *
   * The pivot stores this model's type, so `taggables` can hold tags for posts
   * and videos at once without two tables.
   */
  morphToMany<R extends Model>(
    related: ModelClass<R>,
    name: string,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string,
    morphType = this.self.getTable()
  ): MorphToMany<R> {
    return new MorphToMany(
      related,
      this,
      name,
      pivotTable ?? `${name}s`,
      foreignPivotKey ?? `${name}_id`,
      relatedPivotKey ?? `${Model.snake(related.name)}_${related.primaryKey}`,
      morphType,
      this.self.primaryKey
    )
  }

  /**
   * `tag.posts()` — the inverse, where the *related* models are the polymorphic
   * ones.
   *
   * The pivot's type column then holds the related model's type rather than this
   * one's, which is the only difference and the easiest thing to get backwards.
   */
  morphedByMany<R extends Model>(
    related: ModelClass<R>,
    name: string,
    pivotTable?: string,
    foreignPivotKey?: string,
    relatedPivotKey?: string,
    morphType = related.getTable()
  ): MorphToMany<R> {
    return new MorphToMany(
      related,
      this,
      name,
      pivotTable ?? `${name}s`,
      // The keys swap with the direction: this model is now the "related" one as
      // far as the pivot's column names are concerned.
      foreignPivotKey ?? `${Model.snake(this.self.name)}_${this.self.primaryKey}`,
      relatedPivotKey ?? `${name}_id`,
      morphType,
      this.self.primaryKey
    )
  }

  /**
   * `country.latestPost()` — one row across an intermediate table.
   *
   * The same keys as `hasManyThrough`; only the cardinality differs.
   */
  hasOneThrough<R extends Model>(
    related: ModelClass<R>,
    through: ModelClass<Model>,
    firstKey?: string,
    secondKey?: string
  ): HasOneThrough<R> {
    return new HasOneThrough(
      related,
      this,
      through,
      firstKey ?? this.foreignKeyName(),
      secondKey ?? `${Model.snake(through.name)}_${through.primaryKey}`,
      this.self.primaryKey,
      through.primaryKey
    )
  }

  /**
   * `user.latestPost()` — the newest child of a one-to-many.
   *
   * Not `hasMany().orderBy().limit(1)`: that is right for one parent and wrong for
   * an eager load, where it returns one row for the whole set rather than one per
   * parent. This joins a per-parent aggregate instead.
   */
  latestOfMany<R extends Model>(
    related: ModelClass<R>,
    column = 'created_at',
    foreignKey?: string
  ): HasOneOfMany<R> {
    return new HasOneOfMany(
      related,
      this,
      foreignKey ?? this.foreignKeyName(),
      column,
      'max',
      this.self.primaryKey
    )
  }

  /** The oldest child, by the same mechanism. */
  oldestOfMany<R extends Model>(
    related: ModelClass<R>,
    column = 'created_at',
    foreignKey?: string
  ): HasOneOfMany<R> {
    return new HasOneOfMany(
      related,
      this,
      foreignKey ?? this.foreignKeyName(),
      column,
      'min',
      this.self.primaryKey
    )
  }

  hasManyThrough<R extends Model>(
    related: ModelClass<R>,
    through: ModelClass<Model>,
    firstKey?: string,
    secondKey?: string
  ): HasManyThrough<R> {
    return new HasManyThrough(
      related,
      this,
      through,
      firstKey ?? this.foreignKeyName(),
      secondKey ?? `${Model.snake(through.name)}_${through.primaryKey}`,
      this.self.primaryKey
    )
  }

  /** `user_id` for a `User`. */
  foreignKeyName(): string {
    return `${Model.snake(this.self.name)}_${this.self.primaryKey}`
  }

  static snake(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  }

  setRelation(name: string, value: unknown): this {
    this.relations[name] = value
    return this
  }

  getRelation(name: string): unknown {
    return this.relations[name]
  }

  relationLoaded(name: string): boolean {
    return name in this.relations
  }

  /** Resolve a relation defined as a method on this model. */
  resolveRelation(name: string): Relation<Model> {
    const method = (this as unknown as Record<string, unknown>)[name]

    if (typeof method !== 'function') {
      throw new Error(`Relation [${name}] is not defined on ${this.self.name}.`)
    }

    return (method as () => Relation<Model>).call(this)
  }

  /** Eager-load relations onto an existing instance — Laravel's `load()`. */
  async load(...relations: string[]): Promise<this> {
    const query = await this.newQuery()
    await query.eagerLoadRelations([this], relations)

    return this
  }

  // ------------------------------------------------------------ serialisation

  toObject(): Row {
    const result: Row = {}

    for (const key of Object.keys(this.attributes)) {
      if (this.self.hidden.includes(key)) continue
      result[key] = this.getAttribute(key)
    }

    // Accessor-backed values that have no column of their own.
    for (const key of this.self.appends) {
      if (this.self.hidden.includes(key)) continue
      result[key] = this.getAttribute(key)
    }

    for (const [name, value] of Object.entries(this.relations)) {
      result[name] =
        value instanceof Collection
          ? value.all().map((item) => (item instanceof Model ? item.toObject() : item))
          : value instanceof Model
            ? value.toObject()
            : value
    }

    return result
  }

  toJSON(): Row {
    return this.toObject()
  }

  private async fireEvent(name: string): Promise<void> {
    if (Model.muted) return

    await Model.dispatcher?.dispatch(new ModelEvent(`${Model.snake(this.self.name)}.${name}`, this))
  }
}

/**
 * A pivot row, as a model — `Illuminate\Database\Eloquent\Relations\Pivot`.
 *
 * Declared **here**, beside `Model`, rather than in a file of its own: a subclass
 * in a separate module that `relations.ts` also imports produces a cycle, and the
 * symptom is "Cannot access 'Model' before initialization" at import time rather
 * than anything that points at the cycle. The cache package learned this the same
 * way with `TaggedCache`.
 *
 * The table is set per instance rather than declared, because a pivot class is
 * usually shared: `Membership` is the pivot for `users`↔`teams` and knows its table
 * only from the relation that built it.
 */
export class Pivot extends Model {
  static override timestamps = false

  /**
   * Pivot tables often have no `id`, so nothing may address a row by one.
   *
   * Writes go through the relation (`updateExistingPivot`, `detach`), which keys on
   * the two foreign columns.
   */
  static override incrementing = false

  private pivotTable?: string
  private pivotParentKey?: string
  private pivotRelatedKey?: string

  /**
   * Build one from a row the relation already read.
   *
   * The attributes are **assigned**, not filled: `fill()` honours `fillable`, and
   * a pivot declares none — so constructing with them silently produced an empty
   * pivot. `hydrate()` bypasses fill for exactly the same reason, and this is the
   * pivot's version of it.
   */
  static fromAttributes<T extends Pivot>(
    this: new (
      attributes?: Row
    ) => T,
    attributes: Row,
    table: string,
    foreignKey: string,
    relatedKey: string,
    exists = true
  ): T {
    const pivot = new this()

    pivot.attributes = { ...attributes }
    pivot.usePivot(table, foreignKey, relatedKey)
    pivot.exists = exists
    pivot.syncOriginal()

    return pivot
  }

  usePivot(table: string, foreignKey: string, relatedKey: string): this {
    this.pivotTable = table
    this.pivotParentKey = foreignKey
    this.pivotRelatedKey = relatedKey

    return this
  }

  /** The table this instance belongs to, whatever the class says. */
  override getTable(): string {
    return this.pivotTable ?? (this.constructor as typeof Model).getTable()
  }

  get foreignKey(): string | undefined {
    return this.pivotParentKey
  }

  get relatedKey(): string | undefined {
    return this.pivotRelatedKey
  }
}
