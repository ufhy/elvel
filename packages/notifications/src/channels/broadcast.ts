import type { Notifiable } from '../notifiable.ts'
import type { AnyNotification } from '../notification.ts'

/** The slice of the broadcaster this channel needs. */
export type Broadcasting = {
  broadcast(message: { channel: string; event: string; payload: unknown }): number
}

/**
 * Sends a notification over a websocket — Laravel's `broadcast` channel.
 *
 * The channel a notification goes to is the recipient's own: `notifications.<id>`
 * by default, which is what lets a page subscribe once and receive everything
 * addressed to whoever is signed in. A notifiable may name a different one with
 * `routeNotificationFor('broadcast')`.
 *
 * An **anonymous** recipient is skipped, for the same reason the database
 * channel skips one: `route('broadcast', …)` has no id, so there is no private
 * channel it could belong to, and broadcasting to a guessable name would deliver
 * somebody's notification to whoever subscribed first.
 */
export class BroadcastNotificationChannel {
  readonly name = 'broadcast'

  constructor(private readonly broadcaster: Broadcasting) {}

  async send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown> {
    const channel = this.channelFor(notifiable)

    if (!channel) return null

    const payload =
      typeof (notification as { toBroadcast?: unknown }).toBroadcast === 'function'
        ? (notification as unknown as { toBroadcast(notifiable: Notifiable): unknown }).toBroadcast(
            notifiable
          )
        : typeof notification.toArray === 'function'
          ? notification.toArray(notifiable)
          : {}

    return this.broadcaster.broadcast({
      channel,
      // The class name, so a client can switch on what arrived without the
      // payload having to carry a discriminator of its own.
      event: notification.constructor.name,
      payload: { id: notification.id, ...(payload as Record<string, unknown>) }
    })
  }

  private channelFor(notifiable: Notifiable): string | undefined {
    const routed = notifiable.routeNotificationFor?.('broadcast')

    if (typeof routed === 'string') return routed

    const id =
      typeof notifiable.getKey === 'function' ? notifiable.getKey() : (notifiable.id ?? undefined)

    return id === undefined || id === null ? undefined : `notifications.${String(id)}`
  }
}
