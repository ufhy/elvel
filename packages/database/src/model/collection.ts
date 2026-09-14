import { Collection } from '@elvel/support'
import type { Row } from '../connection/connection.ts'
import type { Model } from './model.ts'

/**
 * A collection of models, with the operations that only make sense over models.
 *
 * `get()` used to hand back `@elvel/support`'s `Collection`, so having fetched a
 * set and then found you need a relation, the answer was a query per model —
 * the N+1 the eager loader exists to prevent. `load()` is that answer, done
 * once.
 *
 * A subclass rather than a second type: everything the plain collection does
 * still works, and `map`/`filter` keep returning what they always did.
 */
export class ModelCollection<M extends Model> extends Collection<M> {
  /**
   * Eager-load relations onto models already fetched.
   *
   * One extra query per relation, not one per model. The models are mutated in
   * place rather than replaced, because the caller is holding them.
   */
  async load(...relations: string[]): Promise<this> {
    const first = this.first()

    if (first === undefined || relations.length === 0) return this

    const builder = (first.constructor as typeof Model).query()

    await builder.eagerLoadRelations(this.all() as never[], relations)

    return this
  }

  /** The same, skipping any that are already there. */
  async loadMissing(...relations: string[]): Promise<this> {
    const missing = relations.filter(
      (relation) => !this.all().every((model) => model.relationLoaded(relation.split('.')[0] ?? ''))
    )

    return this.load(...missing)
  }

  /**
   * Count a relation for models already fetched.
   *
   * One query for the whole set, writing `<relation>_count` onto each model —
   * the same column `withCount()` would have added had the caller known to ask
   * for it before the rows came back.
   */
  async loadCount(...relations: string[]): Promise<this> {
    const first = this.first()

    if (first === undefined || relations.length === 0) return this

    const model = first.constructor as typeof Model

    const counted = await model
      .query()
      .withCount(...relations)
      .whereIn(model.primaryKey, this.modelKeys() as never[])
      .get()

    const byKey = new Map(counted.all().map((one) => [String(one.getKey()), one]))

    for (const one of this) {
      const source = byKey.get(String(one.getKey()))

      if (source === undefined) continue

      for (const relation of relations) {
        const key = `${relation}_count`

        one.setAttribute(key, (source as unknown as Record<string, unknown>)[key])
      }
    }

    return this
  }

  /** The primary keys, which is what an `whereIn` on the next query wants. */
  modelKeys(): unknown[] {
    return this.all().map((model) => model.getKey())
  }

  /** Re-read every model from the database, in one query. */
  async fresh(...relations: string[]): Promise<ModelCollection<M>> {
    const first = this.first()

    if (first === undefined) return new ModelCollection<M>([])

    const model = first.constructor as typeof Model
    const query = model.query()

    if (relations.length > 0) query.with(...relations)

    const rows = await query.whereIn(model.primaryKey, this.modelKeys() as never[]).get()

    // Keyed and looked up, so the order the caller had is the order it keeps.
    const byKey = new Map(rows.all().map((one) => [String(one.getKey()), one]))

    return new ModelCollection<M>(
      this.all()
        .map((one) => byKey.get(String(one.getKey())))
        .filter((one): one is M => one !== undefined)
    )
  }

  /** A query for exactly these models — `whereIn` on their keys. */
  toQuery() {
    const first = this.first()

    if (first === undefined) {
      throw new Error('An empty collection cannot be turned into a query.')
    }

    const model = first.constructor as typeof Model

    return model.query().whereIn(model.primaryKey, this.modelKeys() as never[])
  }

  /** Serialise these attributes even though the model hides them. */
  makeVisible(...keys: string[]): this {
    for (const model of this) model.makeVisible(...keys)

    return this
  }

  makeHidden(...keys: string[]): this {
    for (const model of this) model.makeHidden(...keys)

    return this
  }

  /** Include these accessors when serialising. */
  append(...keys: string[]): this {
    for (const model of this) model.append(...keys)

    return this
  }

  /**
   * By key, not by identity.
   *
   * The plain collection's `only`/`except`/`diff` compare the items themselves,
   * and two reads of the same row are two objects — so every one of them
   * answered wrongly for models.
   */
  onlyKeys(keys: unknown[]): ModelCollection<M> {
    const wanted = new Set(keys.map(String))

    return new ModelCollection(this.all().filter((model) => wanted.has(String(model.getKey()))))
  }

  exceptKeys(keys: unknown[]): ModelCollection<M> {
    const dropped = new Set(keys.map(String))

    return new ModelCollection(this.all().filter((model) => !dropped.has(String(model.getKey()))))
  }

  /** Models this collection has that the other does not, compared by key. */
  diffKeys(other: ModelCollection<M> | M[]): ModelCollection<M> {
    const theirs = new Set(
      (Array.isArray(other) ? other : other.all()).map((model) => String(model.getKey()))
    )

    return new ModelCollection(this.all().filter((model) => !theirs.has(String(model.getKey()))))
  }

  /** Keyed by primary key, which is what a lookup after a fetch wants. */
  keyByPrimary(): Map<string, M> {
    return new Map(this.all().map((model) => [String(model.getKey()), model]))
  }

  /** Every model's attributes, without the model wrapper. */
  toRows(): Row[] {
    return this.all().map((model) => model.toObject() as Row)
  }
}
