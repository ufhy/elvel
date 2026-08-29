import { AnonymousNotifiable, isAnonymous, localeFor, type Notifiable } from './notifiable.ts'
import type { AnyNotification } from './notification.ts'

/** A channel the sender can deliver through. */
export interface NotificationChannel {
  readonly name: string

  send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown>
}

export type SenderEvents = {
  dispatch(event: string, payload?: unknown): unknown
  /**
   * A dispatch a listener can answer — how `notification.sending` is announced.
   *
   * Optional so any object with a `dispatch` still works as an event sink, which
   * is what the tests and the fake pass.
   */
  until?(event: string, payload?: unknown): unknown
}

export type SenderOptions = {
  events?: SenderEvents
  /** How a queued notification is handed off. Absent when there is no queue. */
  queue?: (
    notifiable: Notifiable,
    notification: AnyNotification,
    channel: string
  ) => Promise<string>
  /**
   * The translator, when one is registered.
   *
   * Duck-typed rather than imported: notifications must keep working with no
   * translation package present, and only `preferredLocale()` needs it.
   */
  translator?: { getLocale(): string; setLocale(locale: string): unknown }
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
      const via = channelsOf(channels ?? notification.via(notifiable))
      if (via.length === 0) continue

      // One id per recipient, shared by its channels.
      notification.id = preassigned || crypto.randomUUID()

      /**
       * The recipient's own language, for the duration of this send.
       *
       * Switched here rather than read inside a message, because a notification
       * is rendered long after the request that caused it — often in a worker
       * with no request at all — so `Accept-Language` is not available and would
       * be the wrong answer anyway: the language belongs to the person, not to
       * whoever triggered the notification.
       */
      // The notification's own language wins: `inLocale()` is an explicit
      // instruction, and the recipient's preference is a default.
      await this.inLocale(notification.locale ?? localeFor(notifiable), async () => {
        for (const channel of via) {
          if (channel === 'database' && isAnonymous(notifiable)) continue

          await this.sendToNotifiable(notifiable, notification, channel)
        }
      })
    }
  }

  /**
   * Run `body` with the translator set to `locale`, restoring it afterwards.
   *
   * Restored in a `finally`: a channel that throws must not leave the process
   * speaking the last recipient's language to everybody after them.
   */
  private async inLocale(locale: string | undefined, body: () => Promise<void>): Promise<void> {
    const translator = this.options.translator

    if (!locale || !translator) {
      await body()

      return
    }

    const previous = translator.getLocale()

    translator.setLocale(locale)

    try {
      await body()
    } finally {
      translator.setLocale(previous)
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

      for (const channel of channelsOf(notification.via(notifiable))) {
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

    /**
     * Announced through `until`, so a listener can call it off.
     *
     * Laravel's `NotificationSending` halts the send when a listener returns
     * false, and that is the only hook there is for a decision that belongs
     * outside the notification: a suppression list, a quiet-hours window, a
     * customer who asked for no mail. `shouldSend()` covers the cases the
     * notification itself knows about; this covers the ones it should not have to.
     */
    const sending = {
      notification: notification.constructor.name,
      channel,
      id: notification.id
    }

    const answer = await (this.options.events?.until
      ? this.options.events.until('notification.sending', sending)
      : this.options.events?.dispatch('notification.sending', sending))

    if (answer === false) {
      this.options.events?.dispatch('notification.skipped', {
        notification: notification.constructor.name,
        channel
      })

      return
    }

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

/**
 * The channels a `via()` named, however it named them.
 *
 * A string is one channel, which is what Laravel accepts and what most
 * notifications want. An empty string is nothing rather than a channel called `''`
 * — Laravel pins that too, and without it a `via()` that computes a name and
 * comes back with nothing would try to resolve a driver by empty name.
 */
function channelsOf(via: string[] | string): string[] {
  if (Array.isArray(via)) return via.filter((channel) => channel !== '')

  return via === '' ? [] : [via]
}
