import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ServiceProvider } from '@elvel/core'
import { MakeNotificationCommand } from './console/make-notification.ts'
import { NotificationsTableCommand } from './console/notifications-table.ts'
import { NotificationManager } from './manager.ts'
import type { NotificationClass } from './notification.ts'
import { SendQueuedNotification } from './queued.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    notifications: NotificationManager
  }
}

/**
 * Binds the notification manager and makes queued notifications work.
 *
 * Discovery matters for the same reason it does for jobs: a queued notification
 * carries a class *name*, and a worker in another process has to resolve it.
 */
export class NotificationServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('notifications', (app) => new NotificationManager(app))
  }

  override async boot(): Promise<void> {
    if (this.app.bound('elvel')) {
      this.app.make('elvel').register(MakeNotificationCommand, NotificationsTableCommand)
    }

    const manager = this.app.make('notifications')

    manager.notifications.register(...(await this.discoverNotifications()))

    if (!this.app.bound('queue')) return

    SendQueuedNotification.resolver = {
      channel: (name: string) => manager.channel(name),
      notifications: manager.notifications,
      translator: this.app.bound('translator')
        ? (this.app.make('translator' as never) as {
            getLocale(): string
            setLocale(locale: string): unknown
          })
        : undefined
    }

    this.app.make('queue').jobs.register(SendQueuedNotification)
  }

  /** Every exported class in `app/Notifications` with a `via` method. */
  private async discoverNotifications(): Promise<NotificationClass[]> {
    const directory = this.app.appPath('Notifications')

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }

    const found: NotificationClass[] = []

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>

      for (const exported of Object.values(module)) {
        if (!NotificationServiceProvider.looksLikeNotification(exported)) continue

        found.push(exported as NotificationClass)
      }
    }

    return found
  }

  private static looksLikeNotification(value: unknown): boolean {
    return (
      typeof value === 'function' &&
      typeof (value as { prototype?: { via?: unknown } }).prototype?.via === 'function'
    )
  }
}
