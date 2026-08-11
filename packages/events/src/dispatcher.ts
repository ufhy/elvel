import type {
  EventConstructor,
  EventDispatcher,
  EventKey,
  EventSubscriber,
  Listener,
  WildcardListener
} from '@elysian/contracts'

type StoredListener = (event: string, payload: unknown) => unknown | Promise<unknown>

/**
 * Resolve the key an event is stored under.
 *
 * Classes are addressed by name so wildcard patterns can match them. Declare a
 * static `eventName` when a build step might rename the class:
 *
 * ```ts
 * class UserRegistered { static eventName = 'user.registered' }
 * ```
 */
export function eventName(event: EventKey | object): string {
  if (typeof event === 'string') return event

  // A constructor: read its own statics.
  if (typeof event === 'function') {
    const target = event as { eventName?: unknown; name?: string }

    return typeof target.eventName === 'string' ? target.eventName : (target.name ?? 'unknown')
  }

  // An instance: read the *class's* statics, never the instance's own fields.
  // An event carrying a `name` property must not be renamed by it.
  const target = event.constructor as { eventName?: unknown; name?: string } | undefined

  return typeof target?.eventName === 'string' ? target.eventName : (target?.name ?? 'unknown')
}

/** Translate `user.*` into a regular expression, matching Laravel's `Str::is`. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

  return new RegExp(`^${escaped}$`)
}

/**
 * Event dispatcher.
 *
 * Semantics are taken from `Illuminate\Events\Dispatcher` rather than invented:
 *
 * - a listener returning `false` stops propagation to later listeners
 * - `until()` (dispatch with halting) returns the first non-null response
 * - wildcard listeners are matched by pattern and cached per resolved name
 * - `push()`/`flush()` defer through a synthetic `<event>_pushed` event
 *
 * Queued listeners are deliberately absent until the queue package exists;
 * there is no silent fallback that would run them synchronously and pretend.
 */
export class Dispatcher implements EventDispatcher {
  private readonly listeners = new Map<string, StoredListener[]>()
  private readonly wildcards = new Map<string, WildcardListener[]>()
  private wildcardsCache = new Map<string, StoredListener[]>()

  listen<E extends object>(event: EventConstructor<E>, listener: Listener<E>): void
  listen(event: string | string[], listener: (...args: any[]) => unknown | Promise<unknown>): void
  listen(event: EventKey | string[], listener: Listener | WildcardListener): void {
    const events = Array.isArray(event) ? event : [event]

    for (const entry of events) {
      const name = eventName(entry)

      if (name.includes('*')) {
        this.setupWildcardListen(name, listener as WildcardListener)
        continue
      }

      const stored = this.listeners.get(name) ?? []
      // Non-wildcard listeners receive the payload only, as in Laravel.
      stored.push((_name, payload) => (listener as Listener)(payload))
      this.listeners.set(name, stored)
    }
  }

  private setupWildcardListen(pattern: string, listener: WildcardListener): void {
    const stored = this.wildcards.get(pattern) ?? []
    stored.push(listener)
    this.wildcards.set(pattern, stored)

    // Any new pattern can change what an already-resolved name matches.
    this.wildcardsCache = new Map()
  }

  hasListeners(event: EventKey): boolean {
    const name = eventName(event)

    return (this.listeners.get(name)?.length ?? 0) > 0 || this.hasWildcardListeners(name)
  }

  hasWildcardListeners(event: EventKey): boolean {
    const name = eventName(event)

    for (const pattern of this.wildcards.keys()) {
      if (patternToRegExp(pattern).test(name)) return true
    }

    return false
  }

  subscribe(subscriber: EventSubscriber): void {
    subscriber.subscribe(this)
  }

  /** Every listener for a name: direct ones first, then matching wildcards. */
  getListeners(event: EventKey): StoredListener[] {
    const name = eventName(event)
    const cached = this.wildcardsCache.get(name)
    const wildcards = cached ?? this.resolveWildcardListeners(name)

    if (!cached) this.wildcardsCache.set(name, wildcards)

    return [...(this.listeners.get(name) ?? []), ...wildcards]
  }

  private resolveWildcardListeners(name: string): StoredListener[] {
    const matched: StoredListener[] = []

    for (const [pattern, listeners] of this.wildcards) {
      if (!patternToRegExp(pattern).test(name)) continue
      for (const listener of listeners) {
        matched.push((eventKey, payload) => listener(eventKey, payload))
      }
    }

    return matched
  }

  async dispatch<E extends object>(event: E): Promise<unknown[] | null>
  async dispatch(event: string, payload?: unknown): Promise<unknown[] | null>
  async dispatch(event: object | string, payload?: unknown): Promise<unknown[] | null> {
    return this.invokeListeners(event, payload, false)
  }

  async until<E extends object>(event: E): Promise<unknown>
  async until(event: string, payload?: unknown): Promise<unknown>
  async until(event: object | string, payload?: unknown): Promise<unknown> {
    return this.invokeListeners(event, payload, true)
  }

  protected async invokeListeners(
    event: object | string,
    payload: unknown,
    halt: boolean
  ): Promise<any> {
    const name = eventName(event)
    // A class-based event is its own payload; that is what makes
    // `dispatch(new UserRegistered(user))` read the way it does.
    const resolved = typeof event === 'string' ? payload : event

    const responses: unknown[] = []

    for (const listener of this.getListeners(name)) {
      const response = await listener(name, resolved)

      if (halt && response !== null && response !== undefined) return response

      // Exactly `false` stops propagation, halting or not.
      if (response === false) break

      responses.push(response)
    }

    return halt ? null : responses
  }

  /** Register an event to be dispatched later by `flush()`. */
  push(event: string, payload?: unknown): void {
    this.listen(`${event}_pushed`, () => this.dispatch(event, payload))
  }

  async flush(event: string): Promise<void> {
    await this.dispatch(`${event}_pushed`)
  }

  forget(event: EventKey): void {
    const name = eventName(event)

    if (name.includes('*')) {
      this.wildcards.delete(name)
      this.wildcardsCache = new Map()
      return
    }

    this.listeners.delete(name)
  }

  forgetPushed(): void {
    for (const name of [...this.listeners.keys()]) {
      if (name.endsWith('_pushed')) this.listeners.delete(name)
    }
  }
}
