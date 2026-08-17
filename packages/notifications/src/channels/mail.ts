import { type Content, type Envelope, type Mailable, markdownContent } from '@elvel/mail'
import { type Notifiable, routeFor } from '../notifiable.ts'
import type { AnyNotification } from '../notification.ts'

/** The part of the mail manager this channel needs. */
export type Mailer = {
  mailer(name?: string): {
    send(mailable: Mailable<never>, overrides?: Record<string, unknown>): Promise<unknown>
  }
}

/** A mailable built from a notification's `MailMessage`. */
class NotificationMail {
  constructor(
    readonly data: {
      envelope: Envelope
      content: Content
      attachments: Array<{
        filename: string
        content?: string | Uint8Array
        path?: string
        contentType?: string
      }>
      name: string
    }
  ) {}

  envelope(): Envelope {
    return this.data.envelope
  }

  content(): Content {
    return this.data.content
  }

  attachments() {
    return this.data.attachments
  }
}

/**
 * Sends a notification as mail — Laravel's `MailChannel`.
 *
 * The `MailMessage` is turned into a mailable rather than being sent directly, so
 * everything the mail package already does — the configured sender, `alwaysTo`,
 * the transports, the fake — applies unchanged.
 */
export class MailNotificationChannel {
  readonly name = 'mail'

  constructor(
    private readonly mail: Mailer,
    private readonly appName = 'Elvel'
  ) {}

  async send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown> {
    if (typeof notification.toMail !== 'function') {
      throw new Error(
        `Notification [${notification.constructor.name}] lists the mail channel but has no toMail().`
      )
    }

    const route = routeFor(notifiable, 'mail')

    if (!route) {
      // Not an error: a recipient with no address simply is not mailed, which is
      // what `via()` returning `mail` for everyone in a list has to allow.
      return null
    }

    const message = notification.toMail(notifiable)
    const component = message.viewComponent

    const envelope: Envelope = {
      to: route as string,
      subject: message.subjectOr(notification.constructor.name),
      ...(message.sender ? { from: message.sender } : {}),
      ...(message.replyToOrUndefined ? { replyTo: message.replyToOrUndefined } : {})
    }

    /**
     * Three ways to write the body, in the order they take precedence: one of
     * the application's own components, markdown, or the builder's lines.
     *
     * Markdown goes through the mail package's renderer rather than a second
     * one, so a notification and a mailable written the same way produce the
     * same HTML.
     */
    const markdown = message.markdownSource

    const content: Content = component
      ? { view: component.view, with: component.with, text: message.toText(this.appName) }
      : markdown !== undefined
        ? markdownContent(markdown)
        : { html: message.toHtml(this.appName), text: message.toText(this.appName) }

    const mailable = new NotificationMail({
      envelope,
      content,
      attachments: message.attachments,
      name: notification.constructor.name
    })

    // The mailable's class name is what a `Mail.fake()` assertion sees, so it is
    // set from the notification rather than left as `NotificationMail`.
    Object.defineProperty(mailable.constructor, 'name', {
      value: notification.constructor.name,
      configurable: true
    })

    return this.mail.mailer().send(mailable as unknown as Mailable<never>)
  }
}
