import { Job } from '@elysian/queue'
import type { Notifiable } from './notifiable.ts'
import type { AnyNotification, NotificationRegistry } from './notification.ts'

/** What a queued notification carries. */
export type QueuedNotificationData = {
  notification: string
  data: unknown
  /** The id the sender assigned, so a retry keeps it. */
  id: string
  channel: string
  /** The route for this channel, resolved before queueing. */
  route: unknown
  /** Type and key of the recipient, for the database channel. */
  notifiableType?: string
  notifiableId?: unknown
  /**
   * The language to render in, resolved before queueing.
   *
   * Resolved there because that is the last place the recipient's model exists:
   * a worker gets a rebuilt stand-in with no `preferredLocale()` to ask. Without
   * this the queued copy of a notification came out in the worker's default
   * language while the same notification sent in the request came out in the
   * recipient's — the kind of difference nobody notices until a customer does.
   */
  locale?: string
}

/**
 * A recipient rebuilt from a payload.
 *
 * Only what a channel needs travels: the route it delivers to, and the type and
 * key a stored row belongs to. Serialising the whole model would put a copy of the
 * user in the queue, and a stale one by the time it ran.
 */
class QueuedNotifiable implements Notifiable {
  constructor(private readonly payload: QueuedNotificationData) {}

  routeNotificationFor(channel: string): unknown {
    return channel === this.payload.channel ? this.payload.route : null
  }

  getKey(): unknown {
    return this.payload.notifiableId ?? null
  }

  /**
   * The database channel stores this as `notifiable_type`, so the original model's
   * name has to survive the trip — this object is not an instance of it.
   */
  getNotifiableType(): string {
    return this.payload.notifiableType ?? 'Notifiable'
  }
}

/**
 * Delivers one notification through one channel, from a worker.
 *
 * One job per channel, which is why the channel is in the payload: a mail server
 * being down must not stop the database row from being written, and each can be
 * retried on its own.
 */
export class SendQueuedNotification extends Job<QueuedNotificationData> {
  static override tries = 3

  /** Supplied by the provider, since a worker constructs the job. */
  static resolver: {
    channel(name: string): {
      send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown>
    }
    notifications: NotificationRegistry
    translator?: { getLocale(): string; setLocale(locale: string): unknown }
  } | null = null

  async handle(): Promise<void> {
    const resolver = SendQueuedNotification.resolver

    if (!resolver) {
      throw new Error(
        'Queued notifications need the notification manager. Register NotificationServiceProvider.'
      )
    }

    const notificationClass = resolver.notifications.get(this.data.notification)

    if (!notificationClass) {
      throw new Error(
        `Notification [${this.data.notification}] is not registered. Notifications in app/Notifications are discovered automatically; anything else needs app.make('notifications').notifications.register(TheNotification).`
      )
    }

    const notification = new (
      notificationClass as unknown as new (
        data: unknown
      ) => AnyNotification
    )(this.data.data)

    // The id was assigned before queueing, so a stored row and the mail about it
    // still correlate after a retry.
    notification.id = this.data.id
    notification.locale = this.data.locale

    const deliver = () =>
      resolver.channel(this.data.channel).send(new QueuedNotifiable(this.data), notification)

    const translator = resolver.translator

    if (!this.data.locale || !translator) {
      await deliver()

      return
    }

    const previous = translator.getLocale()

    translator.setLocale(this.data.locale)

    try {
      await deliver()
    } finally {
      // In a `finally`: a worker runs job after job in one process, so a throw
      // here would leave every later notification speaking this recipient's
      // language.
      translator.setLocale(previous)
    }
  }
}
