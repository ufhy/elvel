import type { Notifiable } from './notifiable.ts'
import type { AnyNotification } from './notification.ts'

type Recorded = {
  notifiable: Notifiable
  notification: AnyNotification
  channels: string[]
}

/**
 * Records notifications instead of delivering them — `Notification::fake()`.
 *
 * `via()` is still asked, so an assertion about *which channels* a notification
 * would have used is checking the real decision rather than a stub.
 */
export class NotificationFake {
  private readonly recorded: Recorded[] = []

  /** Called by the manager while faking. */
  record(notifiable: Notifiable, notification: AnyNotification): void {
    this.recorded.push({
      notifiable,
      notification,
      // Normalised here too: an assertion on channels should not have to know
      // whether the notification named one as a string or as a list.
      channels: ([] as string[]).concat(notification.via(notifiable)).filter((one) => one !== '')
    })
  }

  /** Everything recorded, optionally narrowed to one notification. */
  sent(name?: string): Recorded[] {
    return this.recorded.filter(
      (entry) => name === undefined || entry.notification.constructor.name === name
    )
  }

  assertSentTo(
    notifiable: Notifiable,
    name: string,
    matching?: (notification: AnyNotification, channels: string[]) => boolean
  ): void {
    const matches = this.sent(name).filter(
      (entry) =>
        entry.notifiable === notifiable && (matching?.(entry.notification, entry.channels) ?? true)
    )

    if (matches.length === 0) {
      throw new Error(
        `Expected [${name}] to have been sent to that recipient${matching ? ' matching the callback' : ''}, but it was not. Sent: ${this.summary()}`
      )
    }
  }

  assertNotSentTo(notifiable: Notifiable, name: string): void {
    const matches = this.sent(name).filter((entry) => entry.notifiable === notifiable)

    if (matches.length > 0) {
      throw new Error(`Expected [${name}] not to have been sent to that recipient, but it was.`)
    }
  }

  assertSentTimes(name: string, times: number): void {
    const count = this.sent(name).length

    if (count !== times) {
      throw new Error(`Expected [${name}] to have been sent ${times} time(s), but it was ${count}.`)
    }
  }

  /** The channels a notification would have used for a recipient. */
  channelsFor(notifiable: Notifiable, name: string): string[] {
    return this.sent(name).find((entry) => entry.notifiable === notifiable)?.channels ?? []
  }

  assertSentVia(notifiable: Notifiable, name: string, channel: string): void {
    if (!this.channelsFor(notifiable, name).includes(channel)) {
      throw new Error(
        `Expected [${name}] to have been sent via [${channel}], but it used: ${this.channelsFor(notifiable, name).join(', ') || 'nothing'}.`
      )
    }
  }

  assertNothingSent(): void {
    if (this.recorded.length > 0) {
      throw new Error(`Expected nothing to have been sent, but found: ${this.summary()}`)
    }
  }

  flush(): void {
    this.recorded.length = 0
  }

  private summary(): string {
    const names = this.recorded.map((entry) => entry.notification.constructor.name)

    return names.length === 0 ? 'nothing' : [...new Set(names)].join(', ')
  }
}
