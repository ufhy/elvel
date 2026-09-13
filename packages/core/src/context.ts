import { inRequestContext, requestSlot } from './request-context.ts'

/** What a context holds: values that reach a log line, and values that do not. */
type Store = {
  visible: Record<string, unknown>
  hidden: Record<string, unknown>
}

const slot = requestSlot<Store>('context')

/** Outside a unit of work there is nothing to hang it on, so this is it. */
const outside: Store = { visible: {}, hidden: {} }

function store(): Store {
  if (!inRequestContext()) return outside

  let held = slot.get()

  if (held === undefined) {
    held = { visible: {}, hidden: {} }
    slot.set(held)
  }

  return held
}

/** The shape a context takes when it travels — in a job payload, or a header. */
export type SerialisedContext = {
  visible: Record<string, unknown>
  hidden: Record<string, unknown>
}

/**
 * Key/values every log line in this unit of work carries.
 *
 * A logger's shared context covers this process and stops at the queue
 * boundary, which is exactly where it is needed: correlating "this job failed"
 * back to "this request caused it" otherwise means threading an id through
 * every job's constructor and remembering to. This travels in the payload
 * instead — `dehydrate()` at dispatch, `hydrate()` in the worker.
 *
 * Hidden values are visible to the application and never written to a log line,
 * which is how a tenant id or a user id travels without being printed.
 */
class ContextRepository {
  add(key: string, value: unknown): this {
    store().visible[key] = value

    return this
  }

  /** Only when nothing is there — a default, not an overwrite. */
  addIf(key: string, value: unknown): this {
    const held = store()

    if (!(key in held.visible)) held.visible[key] = value

    return this
  }

  get<T = unknown>(key: string): T | undefined
  get<T>(key: string, fallback: T): T
  get<T>(key: string, fallback?: T): T | undefined {
    const held = store()

    return (key in held.visible ? held.visible[key] : fallback) as T | undefined
  }

  has(key: string): boolean {
    return key in store().visible
  }

  /** Read it and remove it, in one step. */
  pull<T = unknown>(key: string): T | undefined {
    const held = store()
    const value = held.visible[key]

    delete held.visible[key]

    return value as T | undefined
  }

  forget(...keys: string[]): this {
    const held = store()

    for (const key of keys) delete held.visible[key]

    return this
  }

  /** Append to a list under a key, creating it. */
  push(key: string, ...values: unknown[]): this {
    const held = store()
    const existing = held.visible[key]

    held.visible[key] = Array.isArray(existing) ? [...existing, ...values] : [...values]

    return this
  }

  pop<T = unknown>(key: string): T | undefined {
    const held = store()
    const existing = held.visible[key]

    if (!Array.isArray(existing) || existing.length === 0) return undefined

    const value = existing.pop()
    held.visible[key] = existing

    return value as T
  }

  all(): Record<string, unknown> {
    return { ...store().visible }
  }

  only(keys: string[]): Record<string, unknown> {
    const held = store().visible

    return Object.fromEntries(keys.filter((key) => key in held).map((key) => [key, held[key]]))
  }

  except(keys: string[]): Record<string, unknown> {
    const dropped = new Set(keys)

    return Object.fromEntries(Object.entries(store().visible).filter(([key]) => !dropped.has(key)))
  }

  // ------------------------------------------------------------------ hidden

  addHidden(key: string, value: unknown): this {
    store().hidden[key] = value

    return this
  }

  getHidden<T = unknown>(key: string): T | undefined
  getHidden<T>(key: string, fallback: T): T
  getHidden<T>(key: string, fallback?: T): T | undefined {
    const held = store()

    return (key in held.hidden ? held.hidden[key] : fallback) as T | undefined
  }

  hasHidden(key: string): boolean {
    return key in store().hidden
  }

  forgetHidden(...keys: string[]): this {
    const held = store()

    for (const key of keys) delete held.hidden[key]

    return this
  }

  allHidden(): Record<string, unknown> {
    return { ...store().hidden }
  }

  // --------------------------------------------------------------- travelling

  /** Everything, ready to travel. `undefined` when there is nothing to carry. */
  dehydrate(): SerialisedContext | undefined {
    const held = store()

    if (Object.keys(held.visible).length === 0 && Object.keys(held.hidden).length === 0) {
      return undefined
    }

    return { visible: { ...held.visible }, hidden: { ...held.hidden } }
  }

  /**
   * Take up a context that travelled.
   *
   * Merged over whatever this unit of work already has rather than replacing it,
   * so a worker that sets its own job id first keeps it.
   */
  hydrate(payload: SerialisedContext | undefined): this {
    if (payload === undefined) return this

    const held = store()

    Object.assign(held.visible, payload.visible)
    Object.assign(held.hidden, payload.hidden)

    return this
  }

  flush(): this {
    const held = store()

    held.visible = {}
    held.hidden = {}

    return this
  }

  /** Run `body` with these values, and without them afterwards. */
  scope<T>(values: Record<string, unknown>, body: () => T): T {
    return slot.run(
      { visible: { ...store().visible, ...values }, hidden: { ...store().hidden } },
      body
    )
  }
}

/** One repository for the process; the values inside it are per unit of work. */
export const Context = new ContextRepository()
