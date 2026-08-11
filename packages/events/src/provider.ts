import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventSubscriber } from '@elysian/contracts'
import { ServiceProvider } from '@elysian/core'
import { Dispatcher } from './dispatcher.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    events: Dispatcher
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
  }

  override async boot(): Promise<void> {
    const dispatcher = this.app.make('events')

    // Auto-discovery: any exported class in app/Listeners with a `subscribe`
    // method is registered. Explicit `listen()` calls in your own provider's
    // boot() remain the norm for one-off listeners.
    for (const subscriber of await this.discoverSubscribers()) {
      dispatcher.subscribe(subscriber)
    }
  }

  private async discoverSubscribers(): Promise<EventSubscriber[]> {
    const directory = this.app.appPath('Listeners')

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }

    const subscribers: EventSubscriber[] = []

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>

      for (const exported of Object.values(module)) {
        if (!this.looksLikeSubscriber(exported)) continue
        subscribers.push(new (exported as new () => EventSubscriber)())
      }
    }

    return subscribers
  }

  private looksLikeSubscriber(value: unknown): boolean {
    return (
      typeof value === 'function' &&
      typeof (value as { prototype?: { subscribe?: unknown } }).prototype?.subscribe === 'function'
    )
  }
}
