import type { MailMessage } from './message.ts'
import type { Notifiable } from './notifiable.ts'

/**
 * Something worth telling someone — Laravel's `Notification`.
 *
 * ```ts
 * export class ArticlePublished extends Notification<{ title: string }> {
 *   via() {
 *     return ['mail', 'database']
 *   }
 *
 *   toMail() {
 *     return new MailMessage()
 *       .subject(`Published: ${this.data.title}`)
 *       .line('Your article is live.')
 *       .action('Read it', url)
 *   }
 *
 *   toDatabase() {
 *     return { title: this.data.title }
 *   }
 * }
 * ```
 *
 * `data` is the constructor argument, as with a job or a mailable — and for the
 * same reason: a notification can be queued, and then only its data travels.
 */
export abstract class Notification<TData = Record<string, never>> {
  /** Set by the sender: one id per notifiable, shared by its channels. */
  id = ''

  constructor(readonly data: TData) {}

  /** Which channels to deliver by, for this recipient. */
  abstract via(notifiable: Notifiable): string[]

  /** The message the mail channel sends. */
  toMail?(notifiable: Notifiable): MailMessage

  /** What the database channel stores. Falls back to `toArray`. */
  toDatabase?(notifiable: Notifiable): Record<string, unknown>

  /** A plain representation, used by the database and log channels. */
  toArray?(notifiable: Notifiable): Record<string, unknown>

  /** Return false to skip this channel for this recipient. */
  shouldSend?(notifiable: Notifiable, channel: string): boolean | Promise<boolean>

  /** Called once a channel has delivered. */
  afterSending?(notifiable: Notifiable, channel: string, response: unknown): void | Promise<void>

  /**
   * Render this notification in a language of its own.
   *
   * Overrides the recipient's `preferredLocale()`, which is the right default
   * and not always right: a receipt copied to an accounts mailbox, or an alert
   * an operations team reads in one language whatever each member prefers, is
   * about the *notification* rather than about the person.
   *
   * ```ts
   * await notify(user, new InvoicePaid({ total }).inLocale('id'))
   * ```
   */
  inLocale(locale: string): this {
    this.locale = locale

    return this
  }

  /** Set by `inLocale`. Read by the sender, ahead of the recipient's own. */
  locale: string | undefined

  /** Stored as the notification's `type`, so a client can switch on it. */
  databaseType(): string {
    return this.constructor.name
  }

  /** Queue this notification instead of sending it in the request. */
  static shouldQueue = false

  /** Queue and connection used when queued. */
  static queue: string | undefined
  static connection: string | undefined
}

/** Any notification, whatever data it carries. */
export type AnyNotification = Notification<unknown>

/** A notification class, as the registry holds it. */
export type NotificationClass = (new (
  data: never
) => AnyNotification) & {
  shouldQueue?: boolean
  queue?: string | undefined
  connection?: string | undefined
}

/**
 * Notifications a worker can resolve by name.
 *
 * The same reasoning as jobs and mailables: a queued payload can only carry a
 * name, and the name has to resolve in a different process.
 */
export class NotificationRegistry {
  private readonly notifications = new Map<string, NotificationClass>()

  register(...notifications: NotificationClass[]): this {
    for (const notification of notifications) {
      this.notifications.set(notification.name, notification)
    }

    return this
  }

  get(name: string): NotificationClass | undefined {
    return this.notifications.get(name)
  }

  has(name: string): boolean {
    return this.notifications.has(name)
  }

  names(): string[] {
    return [...this.notifications.keys()].sort()
  }
}
