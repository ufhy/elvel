import { Collection } from '@elvel/support'
import type { Row } from './connection/connection.ts'
import type { Model, ModelClass } from './model/model.ts'

/**
 * A state callback: the attributes so far, and which of the batch this is.
 *
 * No model type parameter, because it never had one to use — a state receives
 * and returns a plain attribute row, and the model is only involved once the row
 * is written. Carrying an unused `M` made every call site name a type for
 * nothing.
 */
export type FactoryState = (attributes: Row, index: number) => Row | Promise<Row>

/**
 * Model factory.
 *
 * ```ts
 * class UserFactory extends Factory<User> {
 *   model = User
 *
 *   definition(index: number) {
 *     return { name: `User ${index}`, email: `user${index}@example.com` }
 *   }
 * }
 *
 * await new UserFactory().count(3).create()
 * ```
 *
 * There is no bundled fake-data generator: `definition()` receives the index, so
 * unique values come from it rather than from a random source that can collide
 * with a unique index and fail a test one run in fifty.
 *
 * No `connection()`, and the reason is structural: a model's connection is a
 * **static** on its class, so a per-factory override would have to mutate it
 * globally — a race the moment two factories run at once. A model that belongs
 * on another connection declares it, which is where the rest of the framework
 * already reads it from.
 */
export abstract class Factory<M extends Model> {
  abstract readonly model: ModelClass<M>

  private times = 1
  private readonly states: Array<FactoryState> = []
  private overrides: Row = {}

  /** Children to create for each model this factory makes. */
  private readonly children: Array<{
    factory: Factory<Model>
    foreignKey?: string | undefined
  }> = []

  /** Parents to create *before* each model, whose key it then carries. */
  private readonly parents: Array<{ factory: Factory<Model>; foreignKey: string }> = []

  /** Many-to-many attachments, made after the model is saved. */
  private readonly attachments: Array<{
    factory: Factory<Model>
    relation: string
    pivot: Row
  }> = []

  /**
   * biome-ignore-start lint/suspicious/noExplicitAny: what keeps a
   * `Factory<Book>` assignable to the `Factory<Model>` that `has()` and `for()`
   * take. Typed on `M`, these arrays make the class invariant and no concrete
   * factory can be passed to another. The public methods are still typed on
   * `M`, so a caller writing a hook gets its own model.
   */
  private readonly afterMakingHooks: Array<(model: any) => unknown> = []
  private readonly afterCreatingHooks: Array<(model: any) => unknown> = []
  /** biome-ignore-end lint/suspicious/noExplicitAny: see above. */

  /** A parent shared across the whole graph rather than made per child. */
  private readonly recycled = new Map<string, Model>()

  private quiet = false

  /** The attributes a fresh model starts from. `index` is 0-based. */
  abstract definition(index: number): Row | Promise<Row>

  count(times: number): this {
    this.times = Math.max(0, times)
    return this
  }

  /** Layer extra attributes on, one layer at a time. */
  state(state: Row | FactoryState): this {
    this.states.push(typeof state === 'function' ? state : () => state)
    return this
  }

  /** Attributes that win over the definition and every state. */
  with(attributes: Row): this {
    this.overrides = { ...this.overrides, ...attributes }
    return this
  }

  /**
   * Cycle a set of attribute rows across the batch.
   *
   * `sequence({ role: 'admin' }, { role: 'member' })` on a count of four gives
   * two of each. The index wraps, so the number of rows and the length of the
   * sequence need not agree.
   */
  sequence(...rows: Row[]): this {
    if (rows.length === 0) return this

    return this.state((_attributes, index) => rows[index % rows.length] as Row)
  }

  /**
   * Every combination of the sets given, cycled.
   *
   * `crossJoinSequence([{a: 1}, {a: 2}], [{b: 1}, {b: 2}])` is four
   * combinations — which is what a test wants when the interesting thing is the
   * pairing rather than either column.
   */
  crossJoinSequence(...sets: Row[][]): this {
    const combinations = sets.reduce<Row[]>(
      (rows, set) => rows.flatMap((row) => set.map((entry) => ({ ...row, ...entry }))),
      [{}]
    )

    return this.sequence(...combinations)
  }

  /**
   * Children to create for each model — `has(PostFactory.times(3))`.
   *
   * The foreign key defaults to the parent model's name in snake case plus
   * `_id`, which is the convention the relations already use.
   */
  has(factory: Factory<Model>, foreignKey?: string): this {
    this.children.push({ factory, foreignKey })

    return this
  }

  /**
   * A parent to create first, whose key this model then carries.
   *
   * The inverse of `has`, and the one a child factory needs: a comment cannot
   * exist without its post.
   */
  for(factory: Factory<Model>, foreignKey?: string): this {
    this.parents.push({
      factory,
      foreignKey: foreignKey ?? `${snake((factory.model as typeof Model).name)}_id`
    })

    return this
  }

  /** Many-to-many: create these and attach them through the named relation. */
  hasAttached(factory: Factory<Model>, relation: string, pivot: Row = {}): this {
    this.attachments.push({ factory, relation, pivot })

    return this
  }

  /**
   * Share one parent across the whole graph instead of making one per child.
   *
   * Three posts each with five comments would otherwise create fifteen
   * users — one per comment — where the point of the fixture was usually one.
   */
  recycle(...models: Model[]): this {
    for (const model of models) this.recycled.set(model.constructor.name, model)

    return this
  }

  /** Called with each unsaved model, in order. */
  afterMaking(hook: (model: M) => unknown): this {
    this.afterMakingHooks.push(hook)

    return this
  }

  /** Called with each saved model, after its children exist. */
  afterCreating(hook: (model: M) => unknown): this {
    this.afterCreatingHooks.push(hook)

    return this
  }

  /** Save without firing model events — for a seeder that should stay quiet. */
  createQuietly(): Promise<Collection<M>> {
    this.quiet = true

    return this.create()
  }

  /** The attribute sets this factory would use, without touching the database. */
  async raw(): Promise<Row[]> {
    const rows: Row[] = []

    for (let index = 0; index < this.times; index += 1) {
      let attributes = await this.definition(index)

      for (const state of this.states) {
        attributes = { ...attributes, ...(await state(attributes, index)) }
      }

      rows.push({ ...attributes, ...this.overrides })
    }

    return rows
  }

  /** Unsaved models. */
  async make(): Promise<Collection<M>> {
    const rows = await this.raw()

    const models = rows.map((row) => {
      const model = new (this.model as unknown as new () => M)()
      model.forceFill(row)

      return model
    })

    for (const model of models) {
      for (const hook of this.afterMakingHooks) await hook(model)
    }

    return new Collection(models)
  }

  /** One unsaved model. */
  async makeOne(attributes: Row = {}): Promise<M> {
    const made = await this.count(1).with(attributes).make()
    const model = made.first()

    if (!model) throw new Error(`${this.constructor.name} made nothing.`)

    return model
  }

  /** Saved models, with whatever graph was declared around them. */
  async create(): Promise<Collection<M>> {
    /**
     * Parents first, because the child carries their key and the row cannot be
     * written without it.
     */
    const parentKeys: Row = {}

    for (const { factory, foreignKey } of this.parents) {
      const parent = await this.parentFor(factory)

      parentKeys[foreignKey] = parent.getKey()
    }

    if (Object.keys(parentKeys).length > 0) this.with(parentKeys)

    const models = await this.make()

    for (const model of models) {
      await (this.quiet ? model.saveQuietly() : model.save())

      for (const { factory, foreignKey } of this.children) {
        const key = foreignKey ?? `${snake(this.model.name)}_id`

        await factory.with({ [key]: model.getKey() }).create()
      }

      for (const { factory, relation, pivot } of this.attachments) {
        const attached = await factory.create()
        const relationship = model.resolveRelation(relation) as unknown as {
          attach(ids: unknown, extra?: Row): Promise<unknown>
        }

        for (const one of attached) await relationship.attach(one.getKey(), pivot)
      }

      for (const hook of this.afterCreatingHooks) await hook(model)
    }

    return models
  }

  /** Several saved models, as one call. */
  createMany(rows: Row[]): Promise<Collection<M>> {
    return this.count(rows.length)
      .state((_attributes, index) => rows[index] ?? {})
      .create()
  }

  /** A recycled parent, or a fresh one. See `recycle`. */
  private async parentFor(factory: Factory<Model>): Promise<Model> {
    const name = (factory.model as typeof Model).name
    const shared = this.recycled.get(name)

    if (shared !== undefined) return shared

    const created = (await factory.count(1).create()).first()

    if (!created) throw new Error(`${name} factory created nothing to belong to.`)

    // Remembered, so two children of one call share the parent rather than
    // making one each — which is what `recycle` is for and what a graph means.
    this.recycled.set(name, created)

    return created
  }

  /** One saved model, for the common case. */
  async createOne(attributes: Row = {}): Promise<M> {
    const created = await this.count(1).with(attributes).create()
    const model = created.first()

    if (!model) throw new Error(`${this.constructor.name} created nothing.`)

    return model
  }
}

/** `BlogPost` → `blog_post`, which is the convention the relations already use. */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}
