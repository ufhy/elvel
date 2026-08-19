import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventSubscriber } from '@elvel/contracts'
import { ServiceProvider } from '@elvel/core'
import { EventListCommand } from './console/event-list.ts'
import { Dispatcher } from './dispatcher.ts'
import { EventRegistry } from './event-registry.ts'
import { isQueuedListener } from './listener.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    events: Dispatcher
    'events.registry': EventRegistry
  }
}

/**
 * Registers the dispatcher and discovers subscribers.
 *
 * This is one of the framework's base providers, so it must come first in
 * `config/app.ts`: anything else that wants to emit events during boot needs
 * the dispatcher already bound.
 */
export class EventServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('events', () => new Dispatcher())

    // Its own binding, because a worker needs it without a dispatcher having been
    // used: it is what rebuilds the event a queued listener is handed.
    this.app.singleton('events.registry', () => new EventRegistry())
  }

  override async boot(): Promise<void> {
    const dispatcher = this.app.make('events')

    if (this.app.bound('elvel')) this.app.make('elvel').register(EventListCommand)

    // Events first: a subscriber's `listen()` may register a queued listener, and
    // the worker that runs it has to be able to rebuild the event.
    await this.discoverEvents()

    // Auto-discovery: any exported class in app/Listeners with a `subscribe`
    // method is registered. Explicit `listen()` calls in your own provider's
    // boot() remain the norm for one-off listeners.
    for (const subscriber of await this.discoverSubscribers()) {
      dispatcher.subscribe(subscriber)
    }

    // A queued listener that nothing subscribed is still registered, so a worker
    // can resolve it: the process that queued it and the process that runs it are
    // not the same, and only the dispatching one ran the subscriber.
    for (const listener of await this.discoverQueuedListeners()) {
      dispatcher.queuedListeners.register(listener)
    }
  }

  /** Every exported class in `app/Events`, so a payload can become itself again. */
  private async discoverEvents(): Promise<void> {
    const registry = this.app.make('events.registry')

    for (const exported of await this.exportsIn('Events')) {
      if (typeof exported !== 'function') continue

      registry.register(exported as never)
    }
  }

  private async discoverQueuedListeners() {
    const found = []

    for (const exported of await this.exportsIn('Listeners')) {
      if (isQueuedListener(exported)) found.push(exported)
    }

    return found
  }

  private async discoverSubscribers(): Promise<EventSubscriber[]> {
    const subscribers: EventSubscriber[] = []

    for (const exported of await this.exportsIn('Listeners')) {
      if (!this.looksLikeSubscriber(exported)) continue

      subscribers.push(new (exported as new () => EventSubscriber)())
    }

    return subscribers
  }

  /** Every export of every module in `app/<directory>`, in file order. */
  private async exportsIn(directory: string): Promise<unknown[]> {
    const path = this.app.appPath(directory)

    let entries: string[]
    try {
      entries = await readdir(path)
    } catch {
      return []
    }

    const found: unknown[] = []

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(path, entry))) as Record<string, unknown>

      found.push(...Object.values(module))
    }

    return found
  }

  private looksLikeSubscriber(value: unknown): boolean {
    return (
      typeof value === 'function' &&
      typeof (value as { prototype?: { subscribe?: unknown } }).prototype?.subscribe === 'function'
    )
  }
}
