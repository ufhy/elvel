import { NotFoundException } from '@elvel/core'
import { DatabaseNotification, notifications, notify, route } from '@elvel/notifications'
import { Elysia, t } from 'elysia'
import { Article } from '../../Models/Article.ts'
import { ArticlePublished } from '../../Notifications/ArticlePublished.ts'

/**
 * Generated with `bun run playground make:controller NotificationController`,
 * then extended.
 *
 * A recipient here is a plain object with an `email` and a key, which is all the
 * `Notifiable` contract asks for. Asserted by `scripts/smoke.ts` and driven over
 * the network with `elvel serve` + curl.
 */

/** Stands in for a user model: an id, an address, and nothing else. */
class Recipient {
  constructor(
    readonly id: number,
    readonly email?: string,
    private readonly locale?: string
  ) {}

  /** The language this person reads, whatever language the request was in. */
  preferredLocale(): string | undefined {
    return this.locale
  }

  getKey(): unknown {
    return this.id
  }

  /** Stored as `notifiable_type`, so one table can hold every kind. */
  getNotifiableType(): string {
    return 'User'
  }
}

export default new Elysia({ name: 'notification' })
  /** Notify one recipient, or several. */
  .post(
    '/check/notifications/:id',
    async ({ params, body }) => {
      const article = await Article.find(Number(params.id))
      if (!article) throw new NotFoundException(`No article [${params.id}].`)

      const recipients = (body.recipients ?? [{ id: 1, email: 'ada@example.com' }]).map(
        (entry) => new Recipient(entry.id, entry.email)
      )

      const notification = new ArticlePublished({
        title: body.title ?? article.title,
        articleId: article.id,
        urgent: body.urgent === true
      })

      await notify(recipients, notification)

      return {
        notified: recipients.length,
        // The same id is on every channel for one recipient.
        id: notification.id,
        channels: notification.via(recipients[0] as never)
      }
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        urgent: t.Optional(t.Boolean()),
        recipients: t.Optional(t.Array(t.Object({ id: t.Number(), email: t.Optional(t.String()) })))
      })
    }
  )

  /**
   * An on-demand notification: an address with no model behind it.
   *
   * The database channel is skipped for it, because there is no row to own it.
   */
  .post('/check/notifications/route/:id', async ({ params }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    const recipient = route('mail', 'someone@example.com')

    await notify(recipient, new ArticlePublished({ title: article.title, articleId: article.id }))

    return { routed: recipient.channels() }
  })

  /**
   * A queued notification for someone who reads another language.
   *
   * The two halves that matter: the send happens in a worker, in a process that
   * never saw the request, and the recipient's model does not travel — so the
   * language has to have been resolved before the job was queued. Work the queue
   * and read the stored row to see which one it came out in.
   */
  .post('/check/notifications/queued/:id', async ({ params, body }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    const locale =
      typeof (body as { locale?: string })?.locale === 'string'
        ? (body as { locale: string }).locale
        : 'id'

    const notification = new ArticlePublished({ title: article.title, articleId: article.id })

    // Queued explicitly rather than through `shouldQueue`, so the same
    // notification class can be sent both ways from one playground.
    await notifications()
      .sender()
      .queue(new Recipient(9, undefined, locale), notification)

    return { id: notification.id, queued: true }
  })

  /** The inbox: what is stored for a recipient, unread first. */
  .get('/check/notifications', async ({ query }) => {
    const id = String(query.for ?? '1')

    const stored = await DatabaseNotification.query()
      .where('notifiable_type', '=', 'User')
      .where('notifiable_id', '=', id)
      .orderBy('created_at', 'desc')
      .get()

    const unread = await DatabaseNotification.query()
      .where('notifiable_id', '=', id)
      .scope('unread')
      .count()

    return {
      unread,
      notifications: stored.all().map((entry) => ({
        id: entry.id,
        type: entry.type,
        data: entry.data,
        read: entry.isRead()
      }))
    }
  })

  /** Mark one as read. Calling it twice does not move the timestamp. */
  .post('/check/notifications/:id/read', async ({ params }) => {
    const stored = await DatabaseNotification.find(params.id)
    if (!stored) throw new NotFoundException(`No notification [${params.id}].`)

    await stored.markAsRead()

    return { id: stored.id, read: stored.isRead(), readAt: stored.attributes.read_at }
  })

  .delete('/check/notifications', async () => {
    await (await DatabaseNotification.query()).delete()

    return { cleared: true }
  })

  /** Which notifications a worker could resolve by name. */
  .get('/check/notifications/registry', () => ({
    notifications: notifications().notifications.names()
  }))
