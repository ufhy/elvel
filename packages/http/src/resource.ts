import { Collection } from '@elysian/support'

export type Attributes = Record<string, unknown>

/**
 * A value that removes itself from the output.
 *
 * `when()` returning nothing has to be distinguishable from `when()` returning
 * `undefined`, which is a legitimate value to serialise as `null`.
 */
const MISSING = Symbol('missing')

type Missing = typeof MISSING

/** A key whose value should be spread into the parent object. */
class MergeValue {
  constructor(readonly value: Attributes) {}
}

/**
 * Transforms a model into the JSON an API returns.
 *
 * ```ts
 * class UserResource extends JsonResource<User> {
 *   toObject() {
 *     return {
 *       id: this.resource.id,
 *       name: this.resource.name,
 *       posts: this.whenLoaded('posts', () => PostResource.collection(...)),
 *       email: this.when(viewer.isAdmin, () => this.resource.email)
 *     }
 *   }
 * }
 * ```
 *
 * The point of the conditional helpers is that a key which should not appear is
 * *absent*, not `null` — a null tells a client the value exists and is empty.
 */
export abstract class JsonResource<T = unknown> {
  /** Key the payload is nested under. `undefined` returns it bare. */
  static wrap: string | undefined = 'data'

  private extra: Attributes = {}

  constructor(readonly resource: T) {}

  abstract toObject(): Attributes

  /** Extra top-level keys, as Laravel's `additional()`. */
  additional(data: Attributes): this {
    this.extra = { ...this.extra, ...data }
    return this
  }

  /** Include a value only when the condition holds. */
  protected when<V>(condition: unknown, value: V | (() => V)): V | Missing {
    if (!condition) return MISSING

    return typeof value === 'function' ? (value as () => V)() : value
  }

  protected unless<V>(condition: unknown, value: V | (() => V)): V | Missing {
    return this.when(!condition, value)
  }

  /** Include only when the relation was eager-loaded, never lazily fetching. */
  protected whenLoaded<V>(relation: string, value?: V | (() => V)): unknown {
    const model = this.resource as { relationLoaded?: (name: string) => boolean } & Attributes

    if (typeof model?.relationLoaded !== 'function' || !model.relationLoaded(relation)) {
      return MISSING
    }

    if (value === undefined) return model[relation as keyof typeof model]

    return typeof value === 'function' ? (value as () => V)() : value
  }

  protected whenNotNull<V>(value: V): V | Missing {
    return value === null || value === undefined ? MISSING : value
  }

  /** Spread these keys into the parent object rather than nesting them. */
  protected merge(value: Attributes): MergeValue {
    return new MergeValue(value)
  }

  protected mergeWhen(condition: unknown, value: Attributes | (() => Attributes)): unknown {
    if (!condition) return MISSING

    return new MergeValue(typeof value === 'function' ? value() : value)
  }

  /** The payload with missing values removed and merges flattened. */
  resolve(): Attributes {
    return JsonResource.filter(this.toObject())
  }

  private static filter(attributes: Attributes): Attributes {
    const result: Attributes = {}

    for (const [key, value] of Object.entries(attributes)) {
      if (value === MISSING) continue

      if (value instanceof MergeValue) {
        Object.assign(result, JsonResource.filter(value.value))
        continue
      }

      result[key] = JsonResource.normalise(value)
    }

    return result
  }

  private static normalise(value: unknown): unknown {
    if (value instanceof JsonResource) return value.resolve()
    if (value instanceof ResourceCollection) return value.resolve()
    if (value instanceof Collection) return value.all().map(JsonResource.normalise)
    if (Array.isArray(value)) return value.map(JsonResource.normalise)

    return value
  }

  /** The wrapped body, ready to serialise. */
  toObjectWithWrapper(): Attributes {
    const wrap = (this.constructor as typeof JsonResource).wrap
    const payload = this.resolve()

    return wrap === undefined ? { ...payload, ...this.extra } : { [wrap]: payload, ...this.extra }
  }

  toJSON(): Attributes {
    return this.toObjectWithWrapper()
  }

  /** A JSON `Response`, so a handler can return it directly. */
  toResponse(init: ResponseInit = {}): Response {
    return Response.json(this.toObjectWithWrapper(), init)
  }

  /** Wrap many models in this resource. */
  static collection<M, R extends JsonResource<M>>(
    this: new (
      resource: M
    ) => R,
    resources: Iterable<M>
  ): ResourceCollection<M, R> {
    return new ResourceCollection<M, R>(this, resources)
  }
}

/**
 * Many resources of one kind, sharing the parent's wrapper.
 */
export class ResourceCollection<M, R extends JsonResource<M>> {
  private extra: Attributes = {}
  private meta: Attributes = {}

  constructor(
    private readonly resource: new (model: M) => R,
    private readonly models: Iterable<M>
  ) {}

  additional(data: Attributes): this {
    this.extra = { ...this.extra, ...data }
    return this
  }

  /** Pagination totals and the like, emitted under `meta`. */
  withMeta(meta: Attributes): this {
    this.meta = { ...this.meta, ...meta }
    return this
  }

  resolve(): Attributes[] {
    return [...this.models].map((model) => new this.resource(model).resolve())
  }

  toObjectWithWrapper(): Attributes {
    const wrap = (this.resource as unknown as typeof JsonResource).wrap
    const items = this.resolve()

    const body: Attributes = wrap === undefined ? { items } : { [wrap]: items }

    if (Object.keys(this.meta).length > 0) body.meta = this.meta

    return { ...body, ...this.extra }
  }

  toJSON(): Attributes {
    return this.toObjectWithWrapper()
  }

  toResponse(init: ResponseInit = {}): Response {
    return Response.json(this.toObjectWithWrapper(), init)
  }
}

export { MISSING }
