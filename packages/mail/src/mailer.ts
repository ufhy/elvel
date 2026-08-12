import type { ViewComponent } from '@elysian/contracts'
import { type Address, type AnyMailable, addresses } from './mailable.ts'
import type { DeliveryResult, SentMessage, Transport } from './message.ts'

/** Renders a view component to HTML. `@elysian/view` satisfies this. */
export type ViewRenderer = <Props>(
  component: ViewComponent<Props>,
  props: Props
) => Promise<string> | string

export type MailerOptions = {
  /** Used when a mailable's envelope does not name a sender. */
  from?: Address
  /**
   * Deliver everything here instead, keeping the real recipients in a header.
   *
   * Laravel's `Mail::alwaysTo`, and the reason it exists: on a staging copy of
   * production data, one careless send reaches real customers.
   */
  alwaysTo?: Address
  render?: ViewRenderer
  events?: { dispatch(event: string, payload?: unknown): unknown }
  /**
   * How a queued message is handed off.
   *
   * Supplied by the manager so this file needs no knowledge of the queue; absent
   * when no queue is registered, and `queue()` then says so.
   */
  queue?: (
    mailable: AnyMailable,
    overrides: Partial<SentMessage>,
    delay?: number
  ) => Promise<string>
}

/**
 * Builds and sends messages — `Illuminate\Mail\Mailer`.
 *
 * Building and sending are separate on purpose: `build()` is what `render()` and
 * the fake both use, so a preview, an assertion and a real delivery all see the
 * same message.
 */
export class Mailer {
  constructor(
    readonly name: string,
    readonly transport: Transport,
    private readonly options: MailerOptions = {}
  ) {}

  /** Start addressing a message. */
  to(recipients: Address | Address[]): PendingMail {
    return new PendingMail(this).to(recipients)
  }

  cc(recipients: Address | Address[]): PendingMail {
    return new PendingMail(this).cc(recipients)
  }

  bcc(recipients: Address | Address[]): PendingMail {
    return new PendingMail(this).bcc(recipients)
  }

  /** Resolve a mailable into the message a transport would receive. */
  async build(mailable: AnyMailable, overrides: Partial<SentMessage> = {}): Promise<SentMessage> {
    const envelope = mailable.envelope()
    const content = mailable.content()

    const from = addresses(envelope.from ?? this.options.from)[0]

    if (!from) {
      throw new Error(
        `Mailable [${mailable.constructor.name}] has no sender. Set one in its envelope, or configure mail.from.`
      )
    }

    const html = 'view' in content ? await this.renderView(content.view, content.with) : undefined

    const message: SentMessage = {
      mailable: mailable.constructor.name,
      from,
      to: addresses(envelope.to),
      cc: addresses(envelope.cc),
      bcc: addresses(envelope.bcc),
      replyTo: addresses(envelope.replyTo),
      subject: envelope.subject ?? '',
      html: html ?? ('html' in content ? content.html : undefined),
      text: 'text' in content ? content.text : undefined,
      attachments: mailable.attachments(),
      tags: envelope.tags ?? [],
      metadata: envelope.metadata ?? {},
      headers: { ...envelope.headers },
      ...overrides
    }

    return this.applyAlwaysTo(message)
  }

  /** Send a mailable. */
  async send(mailable: AnyMailable, overrides: Partial<SentMessage> = {}): Promise<DeliveryResult> {
    const message = await this.build(mailable, overrides)

    if (message.to.length === 0 && message.cc.length === 0 && message.bcc.length === 0) {
      throw new Error(
        `Mailable [${mailable.constructor.name}] has no recipients. Address it with Mail.to(...), or set them in its envelope.`
      )
    }

    this.options.events?.dispatch('mail.sending', { mailer: this.name, message })

    const result = await this.transport.send(message)

    this.options.events?.dispatch('mail.sent', { mailer: this.name, message, result })

    return result
  }

  /** Put a mailable on the queue. */
  async queue(
    mailable: AnyMailable,
    overrides: Partial<SentMessage> = {},
    delay?: number
  ): Promise<string> {
    if (!this.options.queue) {
      throw new Error(
        'Queued mail needs a queue. Register QueueServiceProvider, or send the message directly.'
      )
    }

    return this.options.queue(mailable, overrides, delay)
  }

  /** The HTML a mailable would send, for a preview route or a snapshot test. */
  async render(mailable: AnyMailable): Promise<string> {
    const message = await this.build(mailable)

    return message.html ?? message.text ?? ''
  }

  private async renderView(component: ViewComponent<never>, props: unknown): Promise<string> {
    if (!this.options.render) {
      throw new Error(
        'This mailer cannot render a view. Register ViewServiceProvider, or use { html } content.'
      )
    }

    return this.options.render(component, props as never)
  }

  /**
   * Redirect every recipient to the configured address.
   *
   * The originals go into headers rather than being dropped, so a developer
   * reading the message can still see who it was for.
   */
  private applyAlwaysTo(message: SentMessage): SentMessage {
    const always = addresses(this.options.alwaysTo)[0]
    if (!always) return message

    const headers = { ...message.headers }

    if (message.to.length > 0) headers['X-Elysian-To'] = message.to.map((m) => m.address).join(', ')
    if (message.cc.length > 0) headers['X-Elysian-Cc'] = message.cc.map((m) => m.address).join(', ')
    if (message.bcc.length > 0) {
      headers['X-Elysian-Bcc'] = message.bcc.map((m) => m.address).join(', ')
    }

    return { ...message, to: [always], cc: [], bcc: [], headers }
  }
}

/**
 * A message being addressed — Laravel's `PendingMail`.
 *
 * Recipients set here win over the mailable's envelope, which is what makes
 * `Mail.to(user.email).send(new Welcome(...))` read the way it does.
 */
export class PendingMail {
  private readonly recipients: {
    to: Address[]
    cc: Address[]
    bcc: Address[]
  } = { to: [], cc: [], bcc: [] }

  constructor(private readonly mailer: Mailer) {}

  to(recipients: Address | Address[]): this {
    this.recipients.to.push(...(Array.isArray(recipients) ? recipients : [recipients]))

    return this
  }

  cc(recipients: Address | Address[]): this {
    this.recipients.cc.push(...(Array.isArray(recipients) ? recipients : [recipients]))

    return this
  }

  bcc(recipients: Address | Address[]): this {
    this.recipients.bcc.push(...(Array.isArray(recipients) ? recipients : [recipients]))

    return this
  }

  /** Send now. */
  async send(mailable: AnyMailable): Promise<DeliveryResult> {
    return this.mailer.send(mailable, this.overrides())
  }

  /**
   * Hand the message to the queue instead of sending it here.
   *
   * The recipients are resolved now and travel with the payload, so a worker does
   * not have to guess who `Mail.to(user.email)` meant.
   */
  async queue(mailable: AnyMailable): Promise<string> {
    return this.mailer.queue(mailable, this.overrides())
  }

  /** Queue it, available after `delay` seconds. */
  async later(delay: number, mailable: AnyMailable): Promise<string> {
    return this.mailer.queue(mailable, this.overrides(), delay)
  }

  /** The message this would send, without sending it. */
  async build(mailable: AnyMailable): Promise<SentMessage> {
    return this.mailer.build(mailable, this.overrides())
  }

  /** Addresses set here, so the mailer can layer them over the envelope. */
  overrides(): Partial<SentMessage> {
    const overrides: Partial<SentMessage> = {}

    if (this.recipients.to.length > 0) overrides.to = addresses(this.recipients.to)
    if (this.recipients.cc.length > 0) overrides.cc = addresses(this.recipients.cc)
    if (this.recipients.bcc.length > 0) overrides.bcc = addresses(this.recipients.bcc)

    return overrides
  }
}
