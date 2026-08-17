import type { EventKey } from '@elyvel/contracts'
import { Dispatcher, eventName } from './dispatcher.ts'

type Recorded = { event: string; payload: unknown }

/**
 * A dispatcher that records instead of dispatching — Laravel's `Event::fake()`.
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

  assertDispatched(event: EventKey, times?: number): void {
    const name = eventName(event)
    const count = this.dispatched(event).length

    if (times === undefined) {
      if (count === 0) throw new Error(`Expected [${name}] to be dispatched, but it was not.`)
      return
    }

    if (count !== times) {
      throw new Error(`Expected [${name}] to be dispatched ${times} time(s), but got ${count}.`)
    }
  }

  assertNotDispatched(event: EventKey): void {
    const count = this.dispatched(event).length

    if (count !== 0) {
      throw new Error(`Expected [${eventName(event)}] not to be dispatched, but got ${count}.`)
    }
  }

  assertNothingDispatched(): void {
    if (this.recorded.length !== 0) {
      const names = [...new Set(this.recorded.map((entry) => entry.event))].join(', ')
      throw new Error(`Expected no events, but these were dispatched: ${names}.`)
    }
  }
}

/**
 * A dispatcher that swallows dispatches entirely — Laravel's `NullDispatcher`.
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
