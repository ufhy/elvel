import type { ApplicationContract } from '@elysian/contracts'
import { DatabaseNotificationChannel } from './channels/database.ts'
import { LogNotificationChannel } from './channels/log.ts'
import { MailNotificationChannel } from './channels/mail.ts'
import { NotificationFake } from './fake.ts'
import { AnonymousNotifiable, identify, type Notifiable, routeFor } from './notifiable.ts'
import {
  type AnyNotification,
  type NotificationClass,
  NotificationRegistry
} from './notification.ts'
import { SendQueuedNotification } from './queued.ts'
import { type NotificationChannel, NotificationSender } from './sender.ts'

/** Builds a channel — how `extend()` adds one. */
export type ChannelFactory = (app: ApplicationContract) => NotificationChannel

/**
 * Resolves channels and sends — Laravel's `ChannelManager`.
 *
 * A channel is built on first use, so an application that never stores a
 * notification never touches the database for it.
 */
export class NotificationManager {
  /** Notifications a worker can resolve by name. Filled by discovery. */
  readonly notifications = new NotificationRegistry()

  private readonly channels = new Map<string, NotificationChannel>()
  private readonly customChannels = new Map<string, ChannelFactory>()
  private faked: NotificationFake | undefined

  constructor(private readonly app: ApplicationContract) {}

  /** Send to one recipient or many. Queued when the notification asks for it. */
  async send(notifiables: Notifiable | Notifiable[], notification: AnyNotification): Promise<void> {
    if (this.faked) {
      for (const notifiable of Array.isArray(notifiables) ? notifiables : [notifiables]) {
        this.faked.record(notifiable, notification)
      }

      return
    }

    // Registered on the way out, so a worker can resolve it even if discovery
    // never saw the class.
    this.notifications.register(notification.constructor as NotificationClass)

    await this.sender().send(notifiables, notification)
  }

  /** Send in this process, whatever the notification asked for. */
  async sendNow(
    notifiables: Notifiable | Notifiable[],
    notification: AnyNotification,
    channels?: string[]
  ): Promise<void> {
    if (this.faked) {
      for (const notifiable of Array.isArray(notifiables) ? notifiables : [notifiables]) {
        this.faked.record(notifiable, notification)
      }

      return
    }

    await this.sender().sendNow(notifiables, notification, channels)
  }

  /** A recipient with no model behind it: `route('mail', 'ada@example.com')`. */
  route(channel: string, route: unknown): AnonymousNotifiable {
    return new AnonymousNotifiable().route(channel, route)
  }

  channel(name: string): NotificationChannel {
    const cached = this.channels.get(name)
    if (cached) return cached

    const channel = this.build(name)
    this.channels.set(name, channel)

    return channel
  }

  extend(name: string, factory: ChannelFactory): this {
    this.customChannels.set(name, factory)
    this.channels.delete(name)

    return this
  }

  /** Record instead of delivering. */
  fake(): NotificationFake {
    this.faked = new NotificationFake()

    return this.faked
  }

  restore(): void {
    this.faked = undefined
  }

  get isFaking(): boolean {
    return this.faked !== undefined
  }

  /** The sender, wired to this manager's channels and the queue. */
  sender(): NotificationSender {
    return new NotificationSender((name) => this.channel(name), {
      events: this.app.bound('events')
        ? (this.app.make('events' as never) as {
            dispatch(event: string, payload?: unknown): unknown
          })
        : undefined,
      queue: this.app.bound('queue')
        ? async (notifiable, notification, channel) => {
            const notificationClass = notification.constructor as NotificationClass

            this.notifications.register(notificationClass)

            const { type, id } = identify(notifiable)

            return this.app.make('queue').dispatch(
              new SendQueuedNotification({
                notification: notificationClass.name,
                data: notification.data,
                id: notification.id,
                channel,
                // Resolved now: a worker cannot ask a model it does not have.
                route: routeFor(notifiable, channel),
                notifiableType: type,
                notifiableId: id
              }),
              { queue: notificationClass.queue, connection: notificationClass.connection }
            )
          }
        : undefined
    })
  }

  private build(name: string): NotificationChannel {
    const custom = this.customChannels.get(name)
    if (custom) return custom(this.app)

    switch (name) {
      case 'mail':
        if (!this.app.bound('mail')) {
          throw new Error('The mail channel needs the mail package. Register MailServiceProvider.')
        }

        return new MailNotificationChannel(
          this.app.make('mail'),
          this.app.config.get<string>('app.name', 'Elysian')
        )

      case 'database':
        if (!this.app.bound('db')) {
          throw new Error(
            'The database channel needs the database package. Register DatabaseServiceProvider.'
          )
        }

        return new DatabaseNotificationChannel(this.app.make('db'), {
          connection: this.app.config.get<string | undefined>('notifications.connection'),
          table: this.app.config.get<string>('notifications.table', 'notifications')
        })

      case 'log':
        return new LogNotificationChannel(
          this.app.bound('log')
            ? (this.app.make('log' as never) as {
                info(message: string, context?: Record<string, unknown>): void
              })
            : { info: (message: string) => console.log(message) }
        )

      default:
        throw new Error(
          `Notification channel [${name}] is not supported. Register it with notifications().extend().`
        )
    }
  }
}
