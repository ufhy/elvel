/**
 * A listener that runs in a worker instead of in the request.
 *
 * ```ts
 * export class SendShipmentNotification extends QueuedListener<OrderShipped> {
 *   static override queue = 'notifications'
 *   static override tries = 3
 *   static override afterCommit = true
 *
 *   async handle(event: OrderShipped): Promise<void> {
 *     await notify(event.customer, new Shipped(event))
 *   }
 * }
 * ```
 *
 * Registered like any other listener — `events.listen(OrderShipped, SendShipmentNotification)`
 * — and the dispatcher pushes a job rather than calling it.
 *
 * A class, not a closure, for one reason: a worker has to find it again. A closure
 * cannot be serialised, so a queued listener is addressed by name, exactly as a
 * job is, and anything in `app/Listeners` is discovered.
 */
export abstract class QueuedListener<E = unknown> {
  /** Name the worker resolves. Override when a build step may rename the class. */
  static listenerName: string | undefined

  /** Queue to push onto. Undefined means the connection's default. */
  static queue: string | undefined

  /** Queue connection to push onto. Undefined means the application default. */
  static connection: string | undefined

  /** Seconds to wait before the job becomes available. */
  static delay: number | undefined

  /** Attempts allowed before the listener is recorded as failed. */
  static tries: number | undefined

  static maxExceptions: number | undefined

  /** Seconds between attempts; a list is indexed by attempt. */
  static backoff: number | number[] | undefined

  /** Seconds one attempt may run. */
  static timeout: number | undefined

  /** Encrypt the payload, so the event's data is not readable in the store. */
  static encrypted = false

  /**
   * Hold the push until the outermost database transaction commits.
   *
   * Without it a worker can reserve the job before the transaction commits and
   * find none of the rows the event is about. Harmless outside a transaction:
   * there is nothing to wait for, so it runs at once.
   */
  static afterCommit = false

  abstract handle(event: E): unknown | Promise<unknown>

  /**
   * Decide at dispatch time whether this event is worth queueing at all.
   *
   * Consulted in the process that dispatched the event, so it can look at request
   * state the worker will not have.
   */
  shouldQueue?(event: E): boolean | Promise<boolean>

  /** Runs in the worker after the final attempt has failed. */
  failed?(event: E, error: unknown): unknown | Promise<unknown>
}

/** The static side of a queued listener — what the dispatcher reads. */
export type QueuedListenerClass<E = unknown> = (new () => QueuedListener<E>) & {
  listenerName?: string | undefined
  queue?: string | undefined
  connection?: string | undefined
  delay?: number | undefined
  tries?: number | undefined
  maxExceptions?: number | undefined
  backoff?: number | number[] | undefined
  timeout?: number | undefined
  encrypted?: boolean
  afterCommit?: boolean
  name: string
}

export type AnyQueuedListenerClass = QueuedListenerClass<never>

/** The name a queued listener is stored and resolved under. */
export function listenerName(listener: AnyQueuedListenerClass): string {
  return typeof listener.listenerName === 'string' ? listener.listenerName : listener.name
}

/** True when a value is a class extending `QueuedListener`. */
export function isQueuedListener(value: unknown): value is AnyQueuedListenerClass {
  if (typeof value !== 'function') return false

  // Walk the chain rather than checking one level: a project's own base class
  // between the listener and `QueuedListener` must still count.
  let current = value as { prototype?: unknown } | null

  while (current) {
    if (current === QueuedListener) return true
    current = Object.getPrototypeOf(current) as { prototype?: unknown } | null
  }

  return false
}

/**
 * Queued listeners a worker can resolve by name.
 *
 * The same shape as the queue's job registry, and for the same reason: the worker
 * is a different process from the one that dispatched the event, so the only
 * thing that travels is a name.
 */
export class ListenerRegistry {
  private readonly listeners = new Map<string, AnyQueuedListenerClass>()

  register(listener: AnyQueuedListenerClass): void {
    this.listeners.set(listenerName(listener), listener)
  }

  has(name: string): boolean {
    return this.listeners.has(name)
  }

  get(name: string): AnyQueuedListenerClass | undefined {
    return this.listeners.get(name)
  }

  names(): string[] {
    return [...this.listeners.keys()].sort()
  }
}
