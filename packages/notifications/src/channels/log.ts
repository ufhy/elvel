import { type Notifiable, routeFor } from '../notifiable.ts'
import type { AnyNotification } from '../notification.ts'

export type LogWriter = { info(message: string, context?: Record<string, unknown>): void }

/**
 * Writes the notification to the log.
 *
 * The safe default while building: a notification that would have gone out is
 * visible, and nothing is delivered.
 */
export class LogNotificationChannel {
  readonly name = 'log'

  constructor(private readonly logger: LogWriter) {}

  async send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown> {
    const payload =
      notification.toArray?.(notifiable) ?? notification.toDatabase?.(notifiable) ?? {}

    this.logger.info(`Notification [${notification.constructor.name}]`, {
      notification: notification.constructor.name,
      id: notification.id,
      route: routeFor(notifiable, 'log') ?? routeFor(notifiable, 'mail'),
      data: payload
    })

    return payload
  }
}
