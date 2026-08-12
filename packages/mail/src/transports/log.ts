import { formatAddress } from '../mailable.ts'
import { type DeliveryResult, recipientsOf, type SentMessage, type Transport } from '../message.ts'

/** Somewhere to write the message. The log package satisfies this. */
export type LogWriter = { info(message: string, context?: Record<string, unknown>): void }

/**
 * Writes the message to the log instead of sending it — Laravel's `log`
 * transport, and the right default for local development.
 *
 * Headers and both bodies are written as readable text rather than as MIME: the
 * point is for a developer to read the mail, and nobody reads
 * `Content-Transfer-Encoding: quoted-printable` for pleasure.
 */
export class LogTransport implements Transport {
  readonly name = 'log'

  constructor(private readonly logger: LogWriter) {}

  async send(message: SentMessage): Promise<DeliveryResult> {
    const lines = [
      `From: ${formatAddress(message.from)}`,
      `To: ${message.to.map(formatAddress).join(', ')}`
    ]

    if (message.cc.length > 0) lines.push(`Cc: ${message.cc.map(formatAddress).join(', ')}`)
    if (message.bcc.length > 0) lines.push(`Bcc: ${message.bcc.map(formatAddress).join(', ')}`)
    if (message.replyTo.length > 0) {
      lines.push(`Reply-To: ${message.replyTo.map(formatAddress).join(', ')}`)
    }

    lines.push(`Subject: ${message.subject}`)

    for (const [name, value] of Object.entries(message.headers)) lines.push(`${name}: ${value}`)

    if (message.attachments.length > 0) {
      lines.push(`Attachments: ${message.attachments.map((file) => file.filename).join(', ')}`)
    }

    lines.push('', message.text ?? message.html ?? '(no body)')

    this.logger.info(`Mail to ${recipientsOf(message).join(', ')}\n${lines.join('\n')}`)

    return { transport: this.name }
  }
}
