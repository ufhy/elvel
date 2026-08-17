import { Job } from '@elvel/queue'
import type { Address, AnyMailable, MailableClass } from './mailable.ts'

/**
 * The mailables a worker can resolve by name.
 *
 * Same reasoning as the job registry: the worker is a different process, so the
 * payload carries a name and the constructor data, never the instance.
 */
export class MailableRegistry {
  private readonly mailables = new Map<string, MailableClass>()

  register(...mailables: MailableClass[]): this {
    for (const mailable of mailables) this.mailables.set(mailable.name, mailable)

    return this
  }

  get(name: string): MailableClass | undefined {
    return this.mailables.get(name)
  }

  has(name: string): boolean {
    return this.mailables.has(name)
  }

  names(): string[] {
    return [...this.mailables.keys()].sort()
  }
}

/** What a queued mail carries. */
export type QueuedMailData = {
  mailable: string
  data: unknown
  mailer?: string
  to?: Address[]
  cc?: Address[]
  bcc?: Address[]
}

/**
 * Sends a mailable from a worker — Laravel's `SendQueuedMailable`.
 *
 * Registered by the mail provider, so `Mail.to(...).queue(...)` works without the
 * application knowing this class exists.
 */
export class SendQueuedMail extends Job<QueuedMailData> {
  static override tries = 3

  /** A provider hands this in, since a job is constructed by the worker. */
  static resolver: {
    mailer(name?: string): {
      send(
        mailable: AnyMailable,
        overrides?: { to?: unknown; cc?: unknown; bcc?: unknown }
      ): Promise<unknown>
    }
    mailables: MailableRegistry
  } | null = null

  async handle(): Promise<void> {
    const resolver = SendQueuedMail.resolver

    if (!resolver) {
      throw new Error('Queued mail needs the mail manager. Register MailServiceProvider.')
    }

    const mailableClass = resolver.mailables.get(this.data.mailable)

    if (!mailableClass) {
      throw new Error(
        `Mailable [${this.data.mailable}] is not registered. Mailables in app/Mail are discovered automatically; anything else needs app.make('mail').mailables.register(TheMailable).`
      )
    }

    const mailable = new (mailableClass as unknown as new (data: unknown) => AnyMailable)(
      this.data.data
    )

    await resolver.mailer(this.data.mailer).send(mailable, {
      ...(this.data.to ? { to: this.data.to } : {}),
      ...(this.data.cc ? { cc: this.data.cc } : {}),
      ...(this.data.bcc ? { bcc: this.data.bcc } : {})
    })
  }
}
