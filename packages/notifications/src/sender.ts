import { AnonymousNotifiable, isAnonymous, type Notifiable } from './notifiable.ts'
import type { AnyNotification } from './notification.ts'

/** A channel the sender can deliver through. */
export interface NotificationChannel {
  readonly name: string

  send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown>
}

export type SenderEvents = { dispatch(event: string, payload?: unknown): unknown }

export type SenderOptions = {
  events?: SenderEvents
  /** How a queued notification is handed off. Absent when there is no queue. */
  queue?: (
    notifiable: Notifiable,
    notification: AnyNotification,
    channel: string
  ) => Promise<string>
}

/**
 * Delivers notifications — `Illuminate\Notifications\NotificationSender`.
 *
 * The order is transcribed rather than reinvented, because each step of it is
 * observable behaviour somebody depends on:
 *
 * 1. Each recipient gets **one id**, shared by every channel it is sent through —
 *    that is what lets a stored notification and the mail about it be correlated.
 * 2. `via()` is asked per recipient, so one notification can mail some people and
 *    only store for others.
 * 3. `shouldSend()` is consulted per channel, after the id is set.
 * 4. A channel that throws dispatches `notification.failed` and the error is
 *    re-thrown, so a worker can retry it.
 * 5. `database` is skipped for an anonymous recipient: there is no row to own it.
 */
export class NotificationSender {
  constructor(
    private readonly channels: (name: string) => NotificationChannel,
    private readonly options: SenderOptions = {}
  ) {}

  /** Queue the notification if it asks to be queued, otherwise send it now. */
  async send(notifiables: Notifiable | Notifiable[], notification: AnyNotification): Promise<void> {
    const shouldQueue = (notification.constructor as { shouldQueue?: boolean }).shouldQueue === true

    if (shouldQueue && this.options.queue) {
      await this.queue(notifiables, notification)

      return
    }

    await this.sendNow(notifiables, notification)
  }

  /** Send in this process, whatever the notification asked for. */
  async sendNow(
    notifiables: Notifiable | Notifiable[],
    notification: AnyNotification,
    channels?: string[]
  ): Promise<void> {
    /**
     * An id the caller (or a queued job) already set is kept; otherwise each
     * recipient gets its own.
     *
     * Read *before* the loop on purpose. Laravel clones the notification per
     * recipient, so each clone starts with an empty id; one shared instance does
     * not, and checking `notification.id` inside the loop would hand every later
     * recipient the first one's id — which would make two people's stored rows
     * indistinguishable.
     */
    const preassigned = notification.id

    for (const notifiable of toList(notifiables)) {
      const via = channels ?? notification.via(notifiable)
      if (via.length === 0) continue

      // One id per recipient, shared by its channels.
      notification.id = preassigned || crypto.randomUUID()

      for (const channel of via) {
        if (channel === 'database' && isAnonymous(notifiable)) continue

        await this.sendToNotifiable(notifiable, notification, channel)
      }
    }
  }

  /** Hand every (recipient, channel) pair to the queue as its own job. */
  async queue(
    notifiables: Notifiable | Notifiable[],
    notification: AnyNotification
  ): Promise<void> {
    if (!this.options.queue) {
      throw new Error(
        'A queued notification needs a queue. Register QueueServiceProvider, or use notifyNow().'
      )
    }

    const preassigned = notification.id

    for (const notifiable of toList(notifiables)) {
      // Same rule as `sendNow`: the id belongs to the delivery, not to the shared
      // notification instance.
      notification.id = preassigned || crypto.randomUUID()

      for (const channel of notification.via(notifiable)) {
        if (channel === 'database' && isAnonymous(notifiable)) continue

        // One job per channel: a mail server being down must not stop the row
        // from being stored, and each can be retried on its own.
        await this.options.queue(notifiable, notification, channel)
      }
    }
  }

  private async sendToNotifiable(
    notifiable: Notifiable,
    notification: AnyNotification,
    channel: string
  ): Promise<void> {
    if (typeof notification.shouldSend === 'function') {
      if ((await notification.shouldSend(notifiable, channel)) === false) {
        this.options.events?.dispatch('notification.skipped', {
          notification: notification.constructor.name,
          channel
        })

        return
      }
    }

    this.options.events?.dispatch('notification.sending', {
      notification: notification.constructor.name,
      channel,
      id: notification.id
    })

    let response: unknown

    try {
      response = await this.channels(channel).send(notifiable, notification)
    } catch (error) {
      this.options.events?.dispatch('notification.failed', {
        notification: notification.constructor.name,
        channel,
        error
      })

      // Re-thrown on purpose: a caller — a worker, usually — has to know, or a
      // failed notification disappears.
      throw error
    }

    await notification.afterSending?.(notifiable, channel, response)

    this.options.events?.dispatch('notification.sent', {
      notification: notification.constructor.name,
      channel,
      id: notification.id,
      response
    })
  }
}

/** One recipient, or many, as a list. */
function toList(notifiables: Notifiable | Notifiable[]): Notifiable[] {
  return Array.isArray(notifiables) ? notifiables : [notifiables]
}

export { AnonymousNotifiable }
