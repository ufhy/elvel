import type { ApplicationContract, EventDispatcher } from '@elysian/contracts'
import { Collection } from '@elysian/support'
import type { Connection, Row } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import { ModelBuilder } from './builder.ts'
import {
  attributeEncrypter,
  type CastEntry,
  type CastType,
  castFromDatabase,
  castToDatabase,
  customCast,
  formatDateTime
} from './casts.ts'
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
  MorphToManyThrough,
  type OfManyColumn,
  type Relation
} from './relations.ts'

export type ConnectionResolver = (name?: string) => Promise<Connection>

/** The lifecycle moments an observer can subscribe to. */
export type ModelLifecycleEvent =
  | 'saving'
  | 'saved'
  | 'creating'
  | 'created'
  | 'updating'
  | 'updated'
  | 'deleting'
  | 'deleted'

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

  static casts: Record<string, CastEntry> = {}

  /**
   * Columns that carry a searchable fingerprint of an encrypted attribute.
   *
   * ```ts
   * static override casts = { email: 'encrypted' }
   * static override blindIndexes = { email: 'email_index' }
   * ```
   *
   * `where('email', …)` against a ciphertext can never match — every write
   * produces different bytes, which is the point of encrypting it. The index
   * column holds an HMAC of the plaintext instead, kept in step on every save,
   * and `whereBlind('email', …)` searches that.
   *
   * The trade is real and belongs in the schema decision: the fingerprint is
   * deterministic, so anyone who can read the column can tell which rows share a
   * value, and for a small domain can confirm a guess by computing it. Index an
   * email address, never a status.
   */
  static blindIndexes: Record<string, string> = {}

  /** Columns removed from `toObject()`/`toJSON()`. */
  static hidden: string[] = []

  /** Accessor-backed keys added to `toObject()` — Laravel's `$appends`. */
  static appends: string[] = []

  /** Scopes applied to every query for this model. */
  static globalScopes: Record<string, (query: ModelBuilder<Model>) => void> = {}

  static softDeletes = false

  /**
   * Rows this model considers expired — `model:prune` deletes what it returns.
   *
   * ```ts
   * static override prunable() {
   *   return this.query().where('created_at', '<', monthsAgo(1))
   * }
   * ```
   *
   * Left undefined a model is never pruned, which is the right default: a
   * command that guessed what "no longer needed" meant would eventually be wrong
   * about somebody's audit table.
   */
  static prunable?: () => ModelBuilder<Model>

  static CREATED_AT = 'created_at'
  static UPDATED_AT = 'updated_at'
  static DELETED_AT = 'deleted_at'

  /**
   * The application, when there is one — for the few things a model reaches out
   * to (notifications, encryption). Undefined outside a booted application, so
   * a model used in isolation still works.
   */
  static applicationOrUndefined(): ApplicationContract | undefined {
    return Model.application
  }

  /** Set by the database provider at boot. */
  static useApplication(application: ApplicationContract): void {
    Model.application = application
  }

  private static application?: ApplicationContract

  private static resolver?: ConnectionResolver
  private static dispatcher?: EventDispatcher

  /** Wired by DatabaseServiceProvider; set by hand in tests. */
  static setConnectionResolver(resolver: ConnectionResolver): void {
    Model.resolver = resolver
  }

  /**
   * Register an observer — a class with `created`/`updated`/`deleted`-shaped
   * methods, each receiving the model.
   *
   * Sugar over the lifecycle events the model already dispatches; it exists so
   * the methods for one model live in one class instead of six `listen()` calls.
   * The dispatcher must be set first, because there is nothing to subscribe to
   * otherwise — and that is said out loud rather than silently doing nothing.
   */
  static observe<T extends typeof Model>(
    this: T,
    observer: Partial<Record<ModelLifecycleEvent, (model: InstanceType<T>) => unknown>>
  ): void {
    if (!Model.dispatcher) {
      throw new Error(
        `${this.name}.observe() needs an event dispatcher. Register EventServiceProvider (or call Model.setEventDispatcher) first.`
      )
    }

    const prefix = Model.snake(this.name)

    for (const [event, handler] of Object.entries(observer)) {
      if (typeof handler !== 'function') continue

      Model.dispatcher.listen(`${prefix}.${event}`, (payload: unknown) =>
        handler((payload as ModelEvent).model as InstanceType<T>)
      )
    }
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
   * Relations whose parents' `updated_at` this model bumps — Laravel's `touches`.
   *
   * `static touches = ['post']` on a Comment means saving or deleting a comment
   * touches its post: a cache keyed on the post's timestamp must expire when a
   * comment changes, and the post's own row is the only place that can say so.
   */
  static touches: string[] = []

  /**
   * Send a notification to this model — Laravel's `$model->notify()`.
   *
   * The model is the notifiable: `routeNotificationFor`, `getKey` and `email`
   * are what the notification package asks for, and a model has all three.
   *
   * Resolved through the container rather than imported, so the database package
   * keeps working with no notifications package present — and says which
   * provider to register when there is not one.
   */
  async notify(notification: unknown): Promise<void> {
    const application = Model.applicationOrUndefined()

    if (!application?.bound('notifications')) {
      throw new Error(
        `[${this.self.name}] cannot notify: register NotificationServiceProvider in config/app.ts.`
      )
    }

    await (
      application.make('notifications' as never) as {
        send(notifiable: unknown, notification: unknown): Promise<void>
      }
    ).send(this, notification)
  }

  /** Send now, even if the notification asked to be queued. */
  async notifyNow(notification: unknown): Promise<void> {
    const application = Model.applicationOrUndefined()

    if (!application?.bound('notifications')) {
      throw new Error(
        `[${this.self.name}] cannot notify: register NotificationServiceProvider in config/app.ts.`
      )
    }

    await (
      application.make('notifications' as never) as {
        sendNow(notifiable: unknown, notification: unknown): Promise<void>
      }
    ).sendNow(this, notification)
  }

  /** Touch every relation `static touches` names. */
  private async touchRelations(): Promise<void> {
    for (const name of this.self.touches) {
      const relation = (this as Record<string, unknown>)[name]
      if (typeof relation !== 'function') continue

      const owner = await (relation.call(this) as { get(): Promise<Model | undefined> }).get()

      await owner?.touch()
    }
  }

  /** Aliases for polymorphic types — `Relation::morphMap`. */
  private static morphAliases = new Map<string, ModelClass<Model>>()

  /**
   * Register short names for polymorphic types — `Relation::morphMap`.
   *
   * Without one, a morph column stores the table name, which welds the database
   * to a code-level naming choice: rename the class (and so the table) and every
   * stored `taggable_type` stops resolving. An alias is a name you commit to.
   */
  static morphMap(map: Record<string, ModelClass<Model>>): void {
    for (const [alias, model] of Object.entries(map)) Model.morphAliases.set(alias, model)
  }

  /** The name this model stores in a morph column: its alias, or its table. */
  static getMorphClass(): string {
    for (const [alias, model] of Model.morphAliases) {
      if (model === (this as unknown as ModelClass<Model>)) return alias
    }

    return this.getTable()
  }

  /** Resolve a stored morph type: an alias first, a table name second. */
  static morphClassFor(type: string): ModelClass<Model> | undefined {
    return Model.morphAliases.get(type)
  }

  /** Is the mass-assignment guard off right now? See `unguarded`. */
  private static guardsDisabled = false

  /**
   * Run `body` with the mass-assignment guard off — `Model::unguarded`.
   *
   * For a seeder or an import that builds models from data *you* wrote: the guard
   * exists to keep request input out of columns it should not reach, and neither
   * of those is request input. Restored in a `finally` for the same reason
   * `withoutEvents` is — a throw must not leave the whole application unguarded.
   */
  static async unguarded<T>(body: () => T | Promise<T>): Promise<T> {
    const wasDisabled = Model.guardsDisabled
    Model.guardsDisabled = true

    try {
      return await body()
    } finally {
      Model.guardsDisabled = wasDisabled
    }
  }

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

  /**
   * The column a route parameter matches — Laravel's `getRouteKeyName`.
   *
   * The primary key unless a model says otherwise. Override it to put slugs in
   * URLs without writing the column at every call site:
   *
   * ```ts
   * class Article extends Model {
   *   static override routeKey = 'slug'
   * }
   * ```
   */
  static routeKey: string | undefined

  static routeKeyName<T extends typeof Model>(this: T): string {
    return this.routeKey ?? this.primaryKey
  }

  /**
   * Find the row a route parameter names — Laravel's `resolveRouteBinding`.
   *
   * `field` is the per-route override, as in `{article:slug}`, and beats the
   * model's own default. Answers `undefined` rather than throwing: what a missing
   * binding means — a 404, a redirect, a fallback — belongs to the caller, and the
   * middleware turns it into a 404.
   */
  static async resolveRouteBinding<T extends typeof Model>(
    this: T,
    value: string,
    field?: string
  ): Promise<InstanceType<T> | undefined> {
    const column = field ?? this.routeKeyName()

    return (await this.query().where(column, value).first()) ?? undefined
  }

  /**
   * The same, scoped to a parent — Laravel's `resolveChildRouteBinding`.
   *
   * `/users/{user}/posts/{post}` must find the post **among that user's posts**.
   * Resolving the child on its own would answer with somebody else's post for a
   * caller who guessed an id, which reads as a working route and is a
   * authorization hole.
   *
   * The relationship is named rather than guessed: a convention mapping `post` to
   * `posts()` breaks on the first irregular plural, and guessing wrong here fails
   * open.
   */
  static async resolveChildRouteBinding<T extends typeof Model>(
    this: T,
    parent: Model,
    relation: string,
    value: string,
    field?: string
  ): Promise<InstanceType<T> | undefined> {
    const accessor = (parent as unknown as Record<string, unknown>)[relation]

    if (typeof accessor !== 'function') {
      throw new Error(
        `[${parent.constructor.name}] has no relation [${relation}] to scope a route binding through.`
      )
    }

    /**
     * Through the relation's own query, which is what constrains it.
     *
     * A relation is not a builder — `hasMany()` returns a `HasMany`, and `.query()`
     * is the builder it has already narrowed to this parent's rows. Querying the
     * child model directly would find the row and lose the scope, which is the
     * bug this method exists to prevent.
     */
    const relationship = (accessor as () => { query(): ModelBuilder<InstanceType<T>> }).call(parent)
    const column = field ?? this.routeKeyName()

    return (await relationship.query().where(column, value).first()) ?? undefined
  }

  /**
   * Delete rows by key — Laravel's `destroy()`.
   *
   * Each row is loaded and deleted individually, which looks wasteful next to one
   * `delete where id in (…)` and is the point: the model events fire, and
   * anything listening for a deletion — a cache flush, an audit line, a cascade
   * written in the application rather than the schema — actually runs.
   *
   * Returns how many were deleted, which is not always how many were asked for.
   */
  static async destroy<T extends typeof Model>(this: T, ids: unknown[] | unknown): Promise<number> {
    const keys = Array.isArray(ids) ? ids : [ids]
    if (keys.length === 0) return 0

    const rows = await this.query()
      .whereIn(this.primaryKey, keys as never[])
      .get()
    let deleted = 0

    for (const row of rows) {
      if (await (row as Model).delete()) deleted += 1
    }

    return deleted
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

    // A custom cast class outranks the built-in names: it was written for this
    // attribute specifically, and it sees the whole row.
    const custom = customCast(cast as CastEntry | undefined)
    if (custom) return custom.get(this, key, value, this.attributes)

    if (cast) return castFromDatabase(value, cast as CastType)

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
    const custom = customCast(cast as CastEntry | undefined)

    if (custom) {
      const stored = custom.set(this, key, value, this.attributes)

      // A cast may return several columns — Money returning amount and currency —
      // and a plain object is how it says so, exactly as Laravel reads it.
      if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
        Object.assign(this.attributes, stored as Row)
      } else {
        this.attributes[key] = stored
      }

      return this
    }

    this.attributes[key] = cast
      ? castToDatabase(value, cast as CastType)
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
    if (Model.guardsDisabled) return true
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

    // Before the dirty set is taken: an index column written afterwards would
    // not be part of the update, and would drift from the value it indexes.
    this.syncBlindIndexes()

    this.changes = this.getDirty()

    const saved = this.exists ? await this.performUpdate(query) : await this.performInsert(query)

    if (saved) {
      await this.fireEvent('saved')
      await this.touchRelations()
      this.syncOriginal()
    }

    return saved
  }

  /**
   * Recompute every blind index whose source attribute changed.
   *
   * Only when it changed: the fingerprint is deterministic, so rewriting it on
   * every save would dirty the row and issue an update for nothing.
   */
  private syncBlindIndexes(): void {
    const indexes = this.self.blindIndexes

    if (Object.keys(indexes).length === 0) return

    const encrypter = attributeEncrypter()

    if (!encrypter?.blindIndex) {
      throw new Error(
        `[${this.self.name}] declares blindIndexes, which need EncryptionServiceProvider. Register it in config/app.ts.`
      )
    }

    for (const [attribute, column] of Object.entries(indexes)) {
      if (this.exists && !(attribute in this.getDirty()) && this.attributes[column] !== undefined) {
        continue
      }

      const value = this.getAttribute(attribute)

      this.attributes[column] =
        value === null || value === undefined
          ? null
          : (encrypter.blindIndex as (value: string, context?: string) => string)(
              String(value),
              `${this.self.getTable()}.${attribute}`
            )
    }
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

  /**
   * Save, or throw — Laravel's `saveOrFail()`.
   *
   * `save()` answers false when nothing was written, and a caller who forgets to
   * check carries on as though it worked. This is for the paths where carrying on
   * is worse than stopping.
   */
  async saveOrFail(): Promise<this> {
    if (!(await this.save())) {
      throw new Error(`Could not save [${this.constructor.name}].`)
    }

    return this
  }

  async deleteOrFail(): Promise<this> {
    if (!(await this.delete())) {
      throw new Error(`Could not delete [${this.constructor.name}].`)
    }

    return this
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

    /**
     * After the delete, and while the foreign keys are still in the attributes:
     * the comment is gone, but the post it counted against has still changed.
     */
    await this.touchRelations()

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
    morphType = this.self.getMorphClass()
  ): MorphMany<R> {
    return new MorphMany(related, this, name, morphType, this.self.primaryKey)
  }

  morphOne<R extends Model>(
    related: ModelClass<R>,
    name: string,
    morphType = this.self.getMorphClass()
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
    morphType = this.self.getMorphClass()
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
    morphType = related.getMorphClass()
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

  /**
   * One child of many, chosen by an arbitrary ordering — Laravel's `ofMany()`.
   *
   * `latestOfMany` is the one-column case. This takes several, applied in order,
   * so "the highest-priced order, and the newest of those if two tie" is
   * expressible; and a `narrow` callback that filters the rows *before* the
   * aggregate runs, which is the only way to ask for "the newest published
   * article" — filtering afterwards asks a different question, because the
   * aggregate has already picked a row by then.
   */
  ofMany<R extends Model>(
    related: ModelClass<R>,
    columns: OfManyColumn[],
    options: { foreignKey?: string; narrow?: (query: QueryBuilder<Row>) => void } = {}
  ): HasOneOfMany<R> {
    return new HasOneOfMany(
      related,
      this,
      options.foreignKey ?? this.foreignKeyName(),
      columns,
      'max',
      this.self.primaryKey,
      options.narrow
    )
  }

  /**
   * A morph pivot reached through another relation.
   *
   * ```ts
   * commentTags() {
   *   return this.morphToManyThrough(Tag, Comment, 'taggable', 'taggables', 'article_id', 'tag_id')
   * }
   * ```
   *
   * "Every tag used on this article's comments" — three tables and a morph type,
   * which neither `morphToMany` nor `hasManyThrough` can express alone.
   */
  morphToManyThrough<R extends Model>(
    related: ModelClass<R>,
    through: ModelClass<Model>,
    morphName: string,
    pivotTable: string,
    throughForeignKey: string,
    relatedPivotKey: string
  ): MorphToManyThrough<R> {
    return new MorphToManyThrough(
      related,
      this,
      through,
      morphName,
      pivotTable,
      throughForeignKey,
      relatedPivotKey,
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
