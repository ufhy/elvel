import { formatAddress } from '../mailable.ts'
import type { DeliveryResult, SentMessage, Transport } from '../message.ts'

/** Shared shape for the provider APIs. */
export type HttpTransportOptions = {
  key: string
  /** Override the endpoint, e.g. for the EU region or a test double. */
  endpoint?: string
}

/** Base64 for an attachment, whichever form it arrived in. */
async function encode(file: { content?: string | Uint8Array; path?: string }): Promise<string> {
  if (file.path !== undefined) {
    return Buffer.from(await Bun.file(file.path).arrayBuffer()).toString('base64')
  }

  if (typeof file.content === 'string') return Buffer.from(file.content).toString('base64')
  if (file.content) return Buffer.from(file.content).toString('base64')

  return ''
}

/** Turn a failed response into an error that names the provider and the reason. */
async function failed(provider: string, response: Response): Promise<never> {
  const body = await response.text()

  throw new Error(`${provider} rejected the message (${response.status}): ${body.slice(0, 300)}`)
}

/**
 * Resend's HTTP API.
 *
 * The HTTP transports need no library at all — a `fetch` and the provider's JSON
 * shape — which is why they are here rather than behind a dependency.
 */
export class ResendTransport implements Transport {
  readonly name = 'resend'

  constructor(private readonly options: HttpTransportOptions) {}

  async send(message: SentMessage): Promise<DeliveryResult> {
    const attachments = await Promise.all(
      message.attachments.map(async (file) => ({
        filename: file.filename,
        content: await encode(file),
        content_type: file.contentType,
        content_id: file.cid
      }))
    )

    const response = await fetch(this.options.endpoint ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: formatAddress(message.from),
        to: message.to.map(formatAddress),
        cc: message.cc.length > 0 ? message.cc.map(formatAddress) : undefined,
        bcc: message.bcc.length > 0 ? message.bcc.map(formatAddress) : undefined,
        reply_to: message.replyTo.length > 0 ? message.replyTo.map(formatAddress) : undefined,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: Object.keys(message.headers).length > 0 ? message.headers : undefined,
        tags: message.tags.length > 0 ? message.tags.map((name) => ({ name })) : undefined,
        attachments: attachments.length > 0 ? attachments : undefined
      })
    })

    if (!response.ok) await failed('Resend', response)

    const body = (await response.json()) as { id?: string }

    return { transport: this.name, id: body.id }
  }
}

/** Postmark's HTTP API. */
export class PostmarkTransport implements Transport {
  readonly name = 'postmark'

  constructor(private readonly options: HttpTransportOptions & { stream?: string }) {}

  async send(message: SentMessage): Promise<DeliveryResult> {
    const attachments = await Promise.all(
      message.attachments.map(async (file) => ({
        Name: file.filename,
        Content: await encode(file),
        ContentType: file.contentType ?? 'application/octet-stream',
        ContentID: file.cid
      }))
    )

    const response = await fetch(this.options.endpoint ?? 'https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': this.options.key,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        From: formatAddress(message.from),
        To: message.to.map(formatAddress).join(', '),
        Cc: message.cc.length > 0 ? message.cc.map(formatAddress).join(', ') : undefined,
        Bcc: message.bcc.length > 0 ? message.bcc.map(formatAddress).join(', ') : undefined,
        ReplyTo:
          message.replyTo.length > 0 ? message.replyTo.map(formatAddress).join(', ') : undefined,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        MessageStream: this.options.stream ?? 'outbound',
        Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
        Attachments: attachments.length > 0 ? attachments : undefined
      })
    })

    if (!response.ok) await failed('Postmark', response)

    const body = (await response.json()) as { MessageID?: string }

    return { transport: this.name, id: body.MessageID }
  }
}

/**
 * Mailgun's HTTP API.
 *
 * Multipart form data rather than JSON, because that is what Mailgun accepts, and
 * the domain is part of the path rather than the payload.
 */
export class MailgunTransport implements Transport {
  readonly name = 'mailgun'

  constructor(private readonly options: HttpTransportOptions & { domain: string }) {}

  async send(message: SentMessage): Promise<DeliveryResult> {
    const form = new FormData()

    form.append('from', formatAddress(message.from))
    for (const mailbox of message.to) form.append('to', formatAddress(mailbox))
    for (const mailbox of message.cc) form.append('cc', formatAddress(mailbox))
    for (const mailbox of message.bcc) form.append('bcc', formatAddress(mailbox))
    for (const mailbox of message.replyTo) form.append('h:Reply-To', formatAddress(mailbox))

    form.append('subject', message.subject)
    if (message.html) form.append('html', message.html)
    if (message.text) form.append('text', message.text)

    for (const [name, value] of Object.entries(message.headers)) form.append(`h:${name}`, value)
    for (const tag of message.tags) form.append('o:tag', tag)
    for (const [key, value] of Object.entries(message.metadata)) {
      form.append(`v:${key}`, value)
    }

    for (const file of message.attachments) {
      const bytes =
        file.path !== undefined
          ? new Uint8Array(await Bun.file(file.path).arrayBuffer())
          : typeof file.content === 'string'
            ? new TextEncoder().encode(file.content)
            : (file.content ?? new Uint8Array())

      form.append(
        file.cid ? 'inline' : 'attachment',
        new File([bytes as BlobPart], file.filename, {
          type: file.contentType ?? 'application/octet-stream'
        })
      )
    }

    const base = this.options.endpoint ?? 'https://api.mailgun.net/v3'

    const response = await fetch(`${base}/${this.options.domain}/messages`, {
      method: 'POST',
      headers: {
        // Mailgun uses basic auth with the literal username `api`.
        authorization: `Basic ${Buffer.from(`api:${this.options.key}`).toString('base64')}`
      },
      body: form
    })

    if (!response.ok) await failed('Mailgun', response)

    const body = (await response.json()) as { id?: string }

    return { transport: this.name, id: body.id }
  }
}
