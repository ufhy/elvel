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
 */
export abstract class Factory<M extends Model> {
  abstract readonly model: ModelClass<M>

  private times = 1
  private readonly states: Array<FactoryState> = []
  private overrides: Row = {}

  /** The attributes a fresh model starts from. `index` is 0-based. */
  abstract definition(index: number): Row | Promise<Row>

  count(times: number): this {
    this.times = Math.max(0, times)
    return this
  }

  /** Layer extra attributes on, as Laravel's states do. */
  state(state: Row | FactoryState): this {
    this.states.push(typeof state === 'function' ? state : () => state)
    return this
  }

  /** Attributes that win over the definition and every state. */
  with(attributes: Row): this {
    this.overrides = { ...this.overrides, ...attributes }
    return this
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

    return new Collection(
      rows.map((row) => {
        const model = new (this.model as unknown as new () => M)()
        model.forceFill(row)

        return model
      })
    )
  }

  /** Saved models. */
  async create(): Promise<Collection<M>> {
    const models = await this.make()

    for (const model of models) await model.save()

    return models
  }

  /** One saved model, for the common case. */
  async createOne(attributes: Row = {}): Promise<M> {
    const created = await this.count(1).with(attributes).create()
    const model = created.first()

    if (!model) throw new Error(`${this.constructor.name} created nothing.`)

    return model
  }
}
