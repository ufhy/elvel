import { Collection } from '@elysian/support'
import type { Row } from '../connection/connection.ts'
import type { ModelBuilder } from './builder.ts'
import type { Model, ModelClass } from './model.ts'

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
  constructor(
    related: ModelClass<R>,
    parent: Model,
    private readonly pivotTable: string,
    private readonly foreignPivotKey: string,
    private readonly relatedPivotKey: string,
    private readonly parentKey = 'id',
    private readonly relatedKey = 'id'
  ) {
    super(related, parent)
  }

  query(): ModelBuilder<R> {
    const relatedTable = (this.related as typeof Model).getTable()

    return ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(`${relatedTable}.*`)
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
  }

  async get(): Promise<Collection<R>> {
    return this.query().get()
  }

  /** Insert pivot rows, ignoring pairs that already exist. */
  async attach(ids: unknown | unknown[]): Promise<void> {
    const values = (Array.isArray(ids) ? ids : [ids]).map((id) => ({
      [this.foreignPivotKey]: this.parent.attributes[this.parentKey],
      [this.relatedPivotKey]: id
    }))

    if (values.length === 0) return

    const query = await ((this.related as typeof Model).query() as ModelBuilder<R>).base()
    await query.clone().from(this.pivotTable).insertOrIgnore(values)
  }

  async detach(ids?: unknown | unknown[]): Promise<number> {
    const query = await ((this.related as typeof Model).query() as ModelBuilder<R>).base()
    const pivot = query
      .clone()
      .from(this.pivotTable)
      .where(this.foreignPivotKey, this.parent.attributes[this.parentKey])

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

  async eagerLoad(models: Model[], name: string): Promise<void> {
    const keys = this.keysOf(models, this.parentKey)

    if (keys.length === 0) {
      for (const model of models) model.setRelation(name, new Collection<R>([]))
      return
    }

    const relatedTable = (this.related as typeof Model).getTable()

    // The pivot's parent key is selected alongside the related columns so the
    // dictionary can be built without a second round trip.
    const rows = await ((this.related as typeof Model).query() as ModelBuilder<R>)
      .select(`${relatedTable}.*`, `${this.pivotTable}.${this.foreignPivotKey} as pivot_parent_key`)
      .join(
        this.pivotTable,
        `${this.pivotTable}.${this.relatedPivotKey}`,
        '=',
        `${relatedTable}.${this.relatedKey}`
      )
      .whereIn(`${this.pivotTable}.${this.foreignPivotKey}`, keys)
      .get()

    const grouped = new Map<string, R[]>()

    for (const row of rows.all()) {
      const pivotKey = row.attributes.pivot_parent_key
      delete row.attributes.pivot_parent_key
      row.syncOriginal()

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
