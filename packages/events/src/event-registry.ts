import { eventName } from './dispatcher.ts'

type AnyEventClass = (new (...args: never[]) => object) & { eventName?: string; name: string }

/**
 * Event classes a worker can rebuild by name.
 *
 * A queued listener runs in a different process, so only the event's *data*
 * travels. Handing the listener a bare object would be a quiet downgrade: the
 * event's own methods and getters would be gone, and `event instanceof OrderShipped`
 * would be false — inside the listener, where that is the least expected.
 *
 * So the class is looked up by name and the data is poured into an instance of it
 * without running the constructor, which is the only faithful option: a
 * constructor may take a model, may take arguments the payload does not carry, and
 * may have side effects that already happened once.
 */
export class EventRegistry {
  private readonly events = new Map<string, AnyEventClass>()

  register(event: AnyEventClass): void {
    this.events.set(eventName(event as unknown as object), event)
  }

  has(name: string): boolean {
    return this.events.has(name)
  }

  names(): string[] {
    return [...this.events.keys()].sort()
  }

  /**
   * Rebuild an event from its name and data.
   *
   * An unregistered event is not an error: the data is handed over as it is, so a
   * listener that only reads fields keeps working. What it loses is `instanceof`
   * and any method, which is why discovery over `app/Events` exists.
   */
  hydrate(name: string, data: unknown): unknown {
    const event = this.events.get(name)

    if (!event || data === null || typeof data !== 'object') return data

    return Object.assign(Object.create(event.prototype as object), data)
  }
}
