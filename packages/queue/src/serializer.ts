import type { Model, ModelClass } from '@elysian/database'

/**
 * A model that travelled through a payload as a reference.
 *
 * Laravel's `SerializesModels` exists for two reasons, and both apply here: a
 * payload carrying a whole record is large, and by the time a worker runs it the
 * record may have changed. Storing the key and re-reading it means the job always
 * sees the current row — and finds out, rather than working on a ghost, when the
 * row has since been deleted.
 */
type ModelReference = {
  __model: string
  key: unknown
  /** Relations that were loaded when the job was dispatched. */
  relations?: string[]
}

function isModelReference(value: unknown): value is ModelReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelReference).__model === 'string' &&
    '__model' in value &&
    'key' in value
  )
}

/**
 * The models a job may name, keyed by the name that goes into the payload.
 *
 * A registry rather than a class reference in the payload: the worker is a
 * different process, and a name is the only thing that survives the trip.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelClass>()

  register(...models: ModelClass[]): this {
    for (const model of models) this.models.set(model.name, model)

    return this
  }

  get(name: string): ModelClass | undefined {
    return this.models.get(name)
  }

  has(name: string): boolean {
    return this.models.has(name)
  }

  names(): string[] {
    return [...this.models.keys()]
  }
}

/** Anything that looks like one of our models. */
function isModel(value: unknown): value is Model & { constructor: { name: string } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getKey?: unknown }).getKey === 'function' &&
    typeof (value as { toObject?: unknown }).toObject === 'function'
  )
}

/**
 * Turn constructor data into something JSON can hold.
 *
 * Only models are treated specially; everything else has to be plain data,
 * which is also the rule the cache package states. A `Date` is kept as an ISO
 * string and restored, because a job dispatched "at" a moment is common enough
 * that silently handing the worker a string would be a trap.
 */
export function serializeData(data: unknown): unknown {
  if (isModel(data)) {
    return {
      __model: data.constructor.name,
      key: data.getKey(),
      relations: Object.keys((data as unknown as { relations: Record<string, unknown> }).relations)
    } satisfies ModelReference
  }

  if (data instanceof Date) return { __date: data.toISOString() }

  if (Array.isArray(data)) return data.map(serializeData)

  if (typeof data === 'object' && data !== null) {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) result[key] = serializeData(value)

    return result
  }

  return data
}

/**
 * Restore what `serializeData` encoded, re-reading any model from the database.
 *
 * A referenced row that has since been deleted throws: a job that quietly ran
 * with a missing model would be worse than one that fails loudly and lands in
 * `queue:failed` with the reason.
 */
export async function deserializeData(data: unknown, models: ModelRegistry): Promise<unknown> {
  if (isModelReference(data)) {
    const model = models.get(data.__model)

    if (!model) {
      throw new Error(
        `Model [${data.__model}] is not registered with the queue. Add it in a provider: app.make('queue').models.register(${data.__model}).`
      )
    }

    const query = model.query()
    if (data.relations && data.relations.length > 0) query.with(...data.relations)

    const found = await query.find(data.key as never)

    if (!found) {
      throw new Error(
        `Model [${data.__model}] with key [${String(data.key)}] no longer exists; the job cannot run.`
      )
    }

    return found
  }

  if (typeof data === 'object' && data !== null && '__date' in data) {
    return new Date(String((data as { __date: unknown }).__date))
  }

  if (Array.isArray(data)) {
    return Promise.all(data.map((entry) => deserializeData(entry, models)))
  }

  if (typeof data === 'object' && data !== null) {
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      result[key] = await deserializeData(value, models)
    }

    return result
  }

  return data
}
