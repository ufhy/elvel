import type { EventKey } from '@elvel/contracts'
import { Dispatcher, eventName } from './dispatcher.ts'

type Recorded = { event: string; payload: unknown }

/**
 * A dispatcher that records instead of dispatching.
 *
 * Listeners stay registered (so `hasListeners` still tells the truth) but they
 * are never invoked, which is what lets a test assert an event fired without
 * running its side effects.
 */
export class EventFake extends Dispatcher {
  private readonly recorded: Recorded[] = []

  /** Events listed here dispatch for real; everything else is only recorded. */
  constructor(private readonly except: EventKey[] = []) {
    super()
  }

  protected override async invokeListeners(
    event: object | string,
    payload: unknown,
    halt: boolean
  ): Promise<any> {
    const name = eventName(event)

    this.recorded.push({ event: name, payload: typeof event === 'string' ? payload : event })

    if (this.except.some((allowed) => eventName(allowed) === name)) {
      return super.invokeListeners(event, payload, halt)
    }

    return halt ? null : []
  }

  /** Every recorded dispatch of an event, in order. */
  dispatched(event: EventKey): unknown[] {
    const name = eventName(event)

    return this.recorded.filter((entry) => entry.event === name).map((entry) => entry.payload)
  }

  all(): Recorded[] {
    return [...this.recorded]
  }

  /**
   * A count, or a look at the payload.
   *
   * The callback is the difference between "an order shipped" and "*this* order
   * shipped" — with several of the same event in one test, a count cannot tell
   * them apart.
   */
  assertDispatched(event: EventKey, check?: number | ((payload: any) => boolean)): void {
    const name = eventName(event)

    if (typeof check === 'function') {
      if (this.dispatched(event).some(check)) return

      throw new Error(
        `Expected a [${name}] matching the callback, and ${describe(this.dispatched(event).length, name)}.`
      )
    }

    const count = this.dispatched(event).length

    if (check === undefined) {
      if (count === 0) throw new Error(`Expected [${name}] to be dispatched, but it was not.`)
      return
    }

    if (count !== check) {
      throw new Error(`Expected [${name}] to be dispatched ${check} time(s), but got ${count}.`)
    }
  }

  assertDispatchedTimes(event: EventKey, times: number): void {
    this.assertDispatched(event, times)
  }

  assertNotDispatched(event: EventKey, check?: (payload: any) => boolean): void {
    const name = eventName(event)
    const matched =
      check === undefined ? this.dispatched(event) : this.dispatched(event).filter(check)

    if (matched.length !== 0) {
      throw new Error(
        check === undefined
          ? `Expected [${name}] not to be dispatched, but got ${matched.length}.`
          : `Expected no [${name}] matching the callback, but ${matched.length} did.`
      )
    }
  }

  /**
   * Whether a provider actually registered its listener.
   *
   * The thing that breaks silently when providers are reordered: the event fires,
   * nobody hears it, and nothing says so.
   */
  assertListening(event: EventKey, listener: unknown): void {
    if (this.listening(event, listener)) return

    const who = typeof listener === 'function' && listener.name !== '' ? listener.name : 'it'

    throw new Error(`Expected [${who}] to be listening for [${eventName(event)}], and it is not.`)
  }

  assertNotListening(event: EventKey, listener: unknown): void {
    if (!this.listening(event, listener)) return

    const who = typeof listener === 'function' && listener.name !== '' ? listener.name : 'it'

    throw new Error(`Expected [${who}] not to be listening for [${eventName(event)}], but it is.`)
  }

  assertNothingDispatched(): void {
    if (this.recorded.length !== 0) {
      const names = [...new Set(this.recorded.map((entry) => entry.event))].join(', ')
      throw new Error(`Expected no events, but these were dispatched: ${names}.`)
    }
  }
}

/**
 * A dispatcher that swallows dispatches entirely.
 *
 * Registration and inspection still work; only `dispatch`, `until` and `push`
 * become no-ops. Useful for seeders and imports that must not fire side effects.
 */
export class NullDispatcher extends Dispatcher {
  protected override async invokeListeners(
    _event: object | string,
    _payload: unknown,
    halt: boolean
  ): Promise<any> {
    return halt ? null : []
  }

  override push(_event: string, _payload?: unknown): void {
    // Deliberately nothing: a pushed event would fire on flush.
  }
}

/** "none was dispatched" reads better than "0 were". */
function describe(count: number, name: string): string {
  if (count === 0) return `no [${name}] was dispatched at all`

  return `the ${count} that were dispatched did not match`
}
