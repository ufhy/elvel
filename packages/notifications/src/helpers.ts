import { app } from '@elyvel/core'
import type { NotificationManager } from './manager.ts'
import type { AnonymousNotifiable, Notifiable } from './notifiable.ts'
import type { AnyNotification } from './notification.ts'

/** The notification manager. */
export function notifications(): NotificationManager {
  return app('notifications')
}

/**
 * Send a notification.
 *
 * ```ts
 * await notify(user, new ArticlePublished({ title }))
 * await notify([editor, author], new ArticlePublished({ title }))
 * ```
 */
export function notify(
  notifiables: Notifiable | Notifiable[],
  notification: AnyNotification
): Promise<void> {
  return notifications().send(notifiables, notification)
}

/** Send now, even if the notification asked to be queued. */
export function notifyNow(
  notifiables: Notifiable | Notifiable[],
  notification: AnyNotification
): Promise<void> {
  return notifications().sendNow(notifiables, notification)
}

/**
 * A recipient that is not a model.
 *
 * ```ts
 * await notify(route('mail', 'ada@example.com'), new Welcome({}))
 * ```
 */
export function route(channel: string, destination: unknown): AnonymousNotifiable {
  return notifications().route(channel, destination)
}
