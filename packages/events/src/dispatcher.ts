import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  EventConstructor,
  EventDispatcher,
  EventKey,
  EventSubscriber,
  Listener,
  WildcardListener
} from '@elysian/contracts'
import {
  type AnyQueuedListenerClass,
  isQueuedListener,
  ListenerRegistry,
  listenerName
} from './listener.ts'

type StoredListener = (event: string, payload: unknown) => unknown | Promise<unknown>

/** One `defer()` in progress: what it is holding, and what it holds back. */
type Deferral = {
  /** The names being deferred, or everything when absent. */
  only: Set<string> | undefined
  held: Array<[object | string, unknown]>
}

/** How a queued listener reaches the queue. Installed by the queue's provider. */
export type QueuedListenerPusher = (
  listener: AnyQueuedListenerClass,
  event: { name: string; payload: unknown }
) => unknown | Promise<unknown>

/** A queued listener class that handles this event type. */
type QueuedListenerClassFor<E> = new () => { handle(event: E): unknown | Promise<unknown> }

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
 * A queued listener is a class rather than a closure — see `QueuedListener` —
 * and the dispatcher pushes it instead of calling it. The push itself belongs to
 * the queue, so it arrives here as an injected hook: this package knows nothing
 * about queues, and there is no silent fallback that would run a queued listener
 * in the request and pretend it was queued.
 */
export class Dispatcher implements EventDispatcher {
  private readonly listeners = new Map<string, StoredListener[]>()
  private readonly wildcards = new Map<string, WildcardListener[]>()
  private wildcardsCache = new Map<string, StoredListener[]>()

  /** Queued listeners a worker can resolve by name. */
  readonly queuedListeners = new ListenerRegistry()

  private pusher: QueuedListenerPusher | undefined

  /**
   * The `defer()` in progress, if any — per async context, not per dispatcher.
   *
   * A flag on the object would be wrong here in a way it is not in Laravel. One
   * dispatcher serves every request in the process, so a deferral held on the
   * instance would swallow the events of every other request that happened to
   * overlap with it. The store follows the callback's async context and nothing
   * else.
   */
  private readonly deferrals = new AsyncLocalStorage<Deferral>()

  /**
   * Teach the dispatcher how to queue — called by the queue's provider.
   *
   * Laravel's `setQueueResolver`, and the same containment: this package depends
   * on `@elysian/contracts` and `@elysian/core` only.
   */
  setQueue(pusher: QueuedListenerPusher): void {
    this.pusher = pusher
  }

  listen<E extends object>(event: EventConstructor<E>, listener: Listener<E>): void
  listen<E extends object>(event: EventConstructor<E>, listener: QueuedListenerClassFor<E>): void
  listen(event: string | string[], listener: (...args: any[]) => unknown | Promise<unknown>): void
  listen(
    event: EventKey | string[],
    listener: Listener | WildcardListener | AnyQueuedListenerClass
  ): void {
    const events = Array.isArray(event) ? event : [event]

    for (const entry of events) {
      const name = eventName(entry)

      if (name.includes('*')) {
        if (isQueuedListener(listener)) {
          /**
           * A queued listener on a pattern.
           *
           * The resolved name travels in the payload beside the event, so the
           * worker can hand the listener both — which is what a pattern listener
           * needs, since `order.*` cannot tell shipped from cancelled by looking
           * at the payload. This used to throw for want of that second argument.
           */
          this.queuedListeners.register(listener)
          this.setupWildcardListen(name, (eventKey, payload) =>
            this.pushToQueue(listener, eventKey, payload)
          )

          continue
        }

        this.setupWildcardListen(name, listener as WildcardListener)
        continue
      }

      const stored = this.listeners.get(name) ?? []

      if (isQueuedListener(listener)) {
        this.queuedListeners.register(listener)
        stored.push((eventKey, payload) => this.pushToQueue(listener, eventKey, payload))
      } else {
        // Non-wildcard listeners receive the payload only, as in Laravel.
        stored.push((_name, payload) => (listener as Listener)(payload))
      }

      this.listeners.set(name, stored)
    }
  }

  /**
   * Every listener for this event, including those on its ancestors.
   *
   * The chain is walked from the event's own class upwards, stopping at
   * `Object`. Listeners run most-specific first, which is the order a reader
   * expects and the order that lets a specific listener return `false` to stop
   * the general ones.
   */
  private listenersFor(event: object | string, name: string): StoredListener[] {
    const own = this.getListeners(name)

    if (typeof event === 'string') return own

    const listeners = [...own]
    let ancestor = Object.getPrototypeOf(event.constructor) as { name?: string } | null

    while (ancestor && typeof ancestor.name === 'string' && ancestor.name !== '') {
      if (ancestor.name !== name) listeners.push(...this.getListeners(ancestor.name))

      ancestor = Object.getPrototypeOf(ancestor) as { name?: string } | null
    }

    return listeners
  }

  /**
   * Hand one event to the queue.
   *
   * `shouldQueue` is asked here, in the dispatching process, because that is the
   * only place that still has the request's state to decide with.
   */
  private async pushToQueue(
    listener: AnyQueuedListenerClass,
    event: string,
    payload: unknown
  ): Promise<unknown> {
    const instance = new listener() as {
      shouldQueue?: (event: unknown) => boolean | Promise<boolean>
    }

    if (typeof instance.shouldQueue === 'function') {
      if ((await instance.shouldQueue(payload)) === false) return undefined
    }

    if (!this.pusher) {
      throw new Error(
        `Listener [${listenerName(listener)}] wants to be queued but no queue is registered. Add QueueServiceProvider to config/app.ts.`
      )
    }

    return this.pusher(listener, { name: event, payload })
  }

  private setupWildcardListen(pattern: string, listener: WildcardListener): void {
    const stored = this.wildcards.get(pattern) ?? []
    stored.push(listener)
    this.wildcards.set(pattern, stored)

    // Any new pattern can change what an already-resolved name matches.
    this.wildcardsCache = new Map()
  }

  /**
   * What is listening to what — the data behind `event:list`.
   *
   * Wildcards are reported separately rather than expanded against the exact
   * names: a pattern matches events that do not exist yet, and folding it into
   * the list of known names would hide exactly the listener that is hard to find
   * when an event fires and nothing happens.
   */
  registered(): { exact: Array<[string, number]>; wildcards: Array<[string, number]> } {
    return {
      exact: [...this.listeners].map(([name, stored]) => [name, stored.length]),
      wildcards: [...this.wildcards].map(([pattern, stored]) => [pattern, stored.length])
    }
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
    const deferral = this.deferrals.getStore()

    if (deferral && (!deferral.only || deferral.only.has(eventName(event)))) {
      deferral.held.push([event, payload])

      return null
    }

    return this.invokeListeners(event, payload, false)
  }

  /**
   * Run `body` with dispatches held back, then dispatch them in order.
   *
   * Laravel's `Event::defer`. What it is for is the half-finished write: an
   * order is created, a payment is taken, an invoice is written, and the third
   * step fails. Without this, two listeners have already emailed the customer
   * about an order that no longer exists. With it, a throw means nothing was
   * ever announced — the events are dropped, not dispatched and not retried.
   *
   * Naming events narrows it: `defer(body, ['order.paid'])` holds that one and
   * lets everything else through.
   *
   * **`until()` is never deferred**, which is a departure. A halting dispatch is
   * a question — the caller wants the answer — and deferring one would answer
   * `null` before any listener had run, which reads as "nobody objected". It
   * runs at once, inside the deferral, as it would outside it.
   */
  async defer<T>(body: () => T | Promise<T>, events?: EventKey[]): Promise<T> {
    const deferral: Deferral = {
      only: events ? new Set(events.map((event) => eventName(event))) : undefined,
      held: []
    }

    // Awaited inside `run`, so everything the callback starts is in the context.
    const result = await this.deferrals.run(deferral, async () => body())

    // Through `invokeListeners` rather than `dispatch`: an enclosing `defer` is
    // not entitled to hold these a second time, having already waited for the
    // callback that produced them.
    for (const [event, payload] of deferral.held) {
      await this.invokeListeners(event, payload, false)
    }

    return result
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

    /**
     * Listeners registered on an **ancestor** run too.
     *
     * Laravel matches a listener registered on an interface the event
     * implements. TypeScript erases interfaces, so there is nothing at runtime
     * to match — but a base class survives, and it carries the same meaning:
     * `listen(DomainEvent, …)` hears every event that extends it.
     *
     * Only for class-based events, and only for ancestors somebody actually
     * registered, so the walk costs nothing on a string event.
     */
    for (const listener of this.listenersFor(event, name)) {
      const response = await listener(name, resolved)

      if (halt && response !== null && response !== undefined) return response

      // Exactly `false` stops propagation, halting or not.
      if (response === false) break

      responses.push(response)
    }

    return halt ? null : responses
  }

  /**
   * Register an event to be dispatched later by `flush()`.
   *
   * Laravel's `push`/`flush` pair, and unrelated to queueing: nothing leaves the
   * process — the event waits in memory until `flush()` names it.
   */
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
