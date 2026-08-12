import type { Mailer } from './mailer.ts'
import type { SentMessage } from './message.ts'
import type { ArrayTransport } from './transports/array.ts'

/**
 * A mailer that records instead of sending — Laravel's `Mail::fake()`.
 *
 * It is a real mailer with the `array` transport behind it, so every message is
 * built for real: the view is rendered, the recipients resolved, the subject
 * settled. An assertion is then checking what would actually have gone out rather
 * than that a method was called.
 */
export class MailFake {
  /** Messages handed to `queue()` while faking. */
  private readonly queuedMail: SentMessage[] = []

  constructor(
    readonly mailer: Mailer,
    private readonly transport: ArrayTransport
  ) {}

  /** Everything "sent", newest last. */
  sent(mailable?: string): SentMessage[] {
    return this.transport.messages.filter(
      (message) => mailable === undefined || message.mailable === mailable
    )
  }

  queued(mailable?: string): SentMessage[] {
    return this.queuedMail.filter(
      (message) => mailable === undefined || message.mailable === mailable
    )
  }

  /** Called by the manager's queue hook while faking. */
  recordQueued(message: SentMessage): void {
    this.queuedMail.push(message)
  }

  assertSent(mailable: string, matching?: (message: SentMessage) => boolean): void {
    const matches = this.sent(mailable).filter((message) => matching?.(message) ?? true)

    if (matches.length === 0) {
      throw new Error(
        `Expected [${mailable}] to have been sent${matching ? ' matching the callback' : ''}, but it was not. Sent: ${this.summary()}`
      )
    }
  }

  assertNotSent(mailable: string): void {
    if (this.sent(mailable).length > 0) {
      throw new Error(`Expected [${mailable}] not to have been sent, but it was.`)
    }
  }

  assertQueued(mailable: string, matching?: (message: SentMessage) => boolean): void {
    const matches = this.queued(mailable).filter((message) => matching?.(message) ?? true)

    if (matches.length === 0) {
      throw new Error(
        `Expected [${mailable}] to have been queued, but it was not. Queued: ${this.summary()}`
      )
    }
  }

  assertNothingSent(): void {
    if (this.transport.messages.length > 0) {
      throw new Error(`Expected nothing to have been sent, but found: ${this.summary()}`)
    }
  }

  assertSentCount(count: number): void {
    if (this.transport.messages.length !== count) {
      throw new Error(
        `Expected ${count} message(s) to have been sent, but found ${this.transport.messages.length}.`
      )
    }
  }

  /** The rendered body of the first matching message, for a content assertion. */
  htmlOf(mailable: string): string | undefined {
    return this.sent(mailable)[0]?.html
  }

  flush(): void {
    this.transport.flush()
    this.queuedMail.length = 0
  }

  private summary(): string {
    const names = [...this.transport.messages, ...this.queuedMail].map(
      (message) => message.mailable
    )

    return names.length === 0 ? 'nothing' : [...new Set(names)].join(', ')
  }
}
