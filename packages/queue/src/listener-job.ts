import type { AnyQueuedListenerClass, EventRegistry, ListenerRegistry } from '@elyvel/events'
import { Job } from './job.ts'

/** What travels for a queued listener: two names and the event's data. */
export type QueuedListenerData = {
  /** The listener class the worker resolves. */
  listener: string
  /** The event's name, so its class can be rebuilt. */
  event: string
  /** The event's own data. */
  payload: unknown
}

/**
 * The job a queued listener travels as — `Illuminate\Events\CallQueuedListener`.
 *
 * A listener is not a job, so one wraps the other: the payload carries the
 * listener's name, the event's name and the event's data, and the worker rebuilds
 * all three. Everything the queue already does — attempts, backoff, timeout,
 * encryption, failure recording — applies unchanged, which is the whole reason for
 * going through a job rather than inventing a second worker.
 *
 * Its per-job options are copied off the listener class at dispatch time by
 * `queuedListenerJob()`, mirroring Laravel's `propagateListenerOptions`.
 */
export class CallQueuedListener extends Job<QueuedListenerData> {
  static listenerRegistry: ListenerRegistry | undefined
  static eventRegistry: EventRegistry | undefined

  /**
   * Registries reach the class rather than the instance.
   *
   * The worker rebuilds this job from a payload, so it constructs it with `data`
   * and nothing else; the resolvers have to be somewhere the payload does not
   * carry, and the provider that owns both sets them at boot.
   */
  static useRegistries(listeners: ListenerRegistry, events: EventRegistry): void {
    CallQueuedListener.listenerRegistry = listeners
    CallQueuedListener.eventRegistry = events
  }

  async handle(): Promise<void> {
    const { listener, event } = this.resolve()

    // The resolved name travels in the payload, which is what lets a queued
    // listener sit on a pattern: `order.*` cannot tell shipped from cancelled
    // from the event object alone.
    await listener.handle(event, this.data.event)
  }

  /**
   * Forward the failure to the listener's own `failed()`, with the event.
   *
   * Laravel passes the event and the exception, and so do we: a listener that
   * wants to record what it could not do needs to know *what* it was.
   */
  override async failed(error: unknown): Promise<void> {
    const { listener, event } = this.resolve()

    if (typeof listener.failed === 'function') await listener.failed(event, error)
  }

  private resolve(): {
    listener: {
      handle(event: unknown, name?: string): unknown
      failed?(event: unknown, error: unknown): unknown
    }
    event: unknown
  } {
    const listeners = CallQueuedListener.listenerRegistry
    const listener = listeners?.get(this.data.listener)

    if (!listener) {
      throw new Error(
        `Queued listener [${this.data.listener}] is not registered. Listeners in app/Listeners are discovered automatically; anything else needs app.make('events').queuedListeners.register(TheListener).`
      )
    }

    // An unregistered event still hands over its data, so a listener that only
    // reads fields keeps working; see EventRegistry for what is lost.
    const event = CallQueuedListener.eventRegistry?.hydrate(this.data.event, this.data.payload)

    return {
      listener: new listener() as never,
      event: event ?? this.data.payload
    }
  }
}

/**
 * Build the job for one (listener, event) pair, carrying the listener's options.
 *
 * Laravel's `propagateListenerOptions`: what a job declares with statics, a queued
 * listener declares the same way, and the values are copied onto the job class so
 * the queue reads them where it already looks.
 */
export function queuedListenerJob(
  listener: AnyQueuedListenerClass,
  name: string,
  event: { name: string; payload: unknown }
): CallQueuedListener {
  /**
   * A subclass per listener, rather than mutating `CallQueuedListener`.
   *
   * The statics are read off the *class* when the job is dispatched, so two
   * listeners with different `tries` queued in the same tick would otherwise
   * overwrite each other's options.
   */
  const carrier = class extends CallQueuedListener {
    // `queue:failed` should say which listener failed, not that a wrapper did.
    static override displayName = name
    static override queue = listener.queue
    static override connection = listener.connection
    static override tries = listener.tries
    static override maxExceptions = listener.maxExceptions
    static override backoff = listener.backoff
    static override timeout = listener.timeout
    static override encrypted = listener.encrypted === true
  }

  // The payload records the *job* name, and a worker resolves the class by it —
  // so it has to stay `CallQueuedListener` however many subclasses exist here.
  Object.defineProperty(carrier, 'name', { value: 'CallQueuedListener' })

  return new carrier({ listener: name, event: event.name, payload: event.payload })
}
