import type { Notifiable } from '@elysian/notifications'
import { MailMessage, Notification } from '@elysian/notifications'

/**
 * Generated with `bun run playground make:notification ArticlePublished`, then
 * extended.
 *
 * One notification, three channels, and `via()` decides per recipient — which is
 * the whole reason notifications exist separately from mail: the same event
 * reaches an editor by mail and shows up in everyone's inbox.
 */
export class ArticlePublished extends Notification<{
  title: string
  articleId: number
  urgent?: boolean
}> {
  /** Delivered in the request here; set to true to hand it to a worker instead. */
  static override shouldQueue = false

  /** Queue used when it is queued. */
  static override queue = 'notifications'

  via(notifiable: Notifiable): string[] {
    // Everyone gets a stored row; only a recipient with an address is mailed.
    const channels = ['database', 'log']

    if (notifiable.email) channels.unshift('mail')

    return channels
  }

  override toMail(): MailMessage {
    const message = new MailMessage()
      .subject(`Published: ${this.data.title}`)
      .greeting('Hello!')
      .line(`"${this.data.title}" is live.`)
      .action('Read it', `http://localhost:3000/check/articles/${this.data.articleId}`)
      .line('Thank you for writing with us.')

    // The level only changes the presentation, which is why it is not a channel.
    return this.data.urgent ? message.error() : message.success()
  }

  /** What an in-app inbox reads. */
  override toDatabase(): Record<string, unknown> {
    return {
      title: this.data.title,
      articleId: this.data.articleId,
      url: `/check/articles/${this.data.articleId}`
    }
  }

  /** Used by the log channel, and as a fallback for the database one. */
  override toArray(): Record<string, unknown> {
    return this.toDatabase()
  }

  /** A recipient who asked not to hear about drafts still gets the row. */
  override shouldSend(_notifiable: Notifiable, channel: string): boolean {
    return !(channel === 'mail' && this.data.title.startsWith('Draft:'))
  }
}
