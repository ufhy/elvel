import { type Credentials, signRequest } from '@elvel/support'
import MailComposer from 'nodemailer/lib/mail-composer'
import { formatAddress } from '../mailable.ts'
import type { DeliveryResult, SentMessage, Transport } from '../message.ts'

export type SesOptions = Credentials & {
  region: string
  /** Override the endpoint — for a VPC endpoint, or a test double. */
  endpoint?: string
  /** SES configuration set applied to every message. */
  configurationSet?: string
  /** Send from a verified identity you are authorised to use on behalf of. */
  fromArn?: string
}

/**
 * Amazon SES v2.
 *
 * Two shapes go over the wire, and which one is used is not a preference:
 *
 * - **Simple** — subject and body as fields. SES builds the MIME itself, which
 *   is what you want when there is nothing to attach.
 * - **Raw** — the whole MIME document, base64. Required the moment there is an
 *   attachment or an embedded image, because Simple has nowhere to put one.
 *
 * The MIME for the raw case is built by nodemailer's composer, already a
 * dependency for SMTP. Writing it here would mean owning multipart boundaries,
 * header folding and quoted-printable — the same encoder we deliberately do not
 * own for SMTP, and no more correct for being written twice.
 *
 * The request is signed with SigV4 rather than reaching for the AWS SDK, which
 * would be hundreds of packages to sign one POST. See `@elvel/support`'s `sigv4.ts`: it passes
 * AWS's own published test vectors.
 */
export class SesTransport implements Transport {
  readonly name = 'ses'

  constructor(private readonly options: SesOptions) {}

  private get endpoint(): string {
    return this.options.endpoint ?? `https://email.${this.options.region}.amazonaws.com`
  }

  async send(message: SentMessage): Promise<DeliveryResult> {
    const body = JSON.stringify(await this.payload(message))
    const url = `${this.endpoint}/v2/email/outbound-emails`

    const headers = signRequest(
      {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        region: this.options.region,
        service: 'ses',
        now: new Date()
      },
      this.options
    )

    const response = await fetch(url, { method: 'POST', headers, body })

    if (!response.ok) {
      const text = await response.text()

      throw new Error(`SES rejected the message (${response.status}): ${text.slice(0, 300)}`)
    }

    const result = (await response.json()) as { MessageId?: string }

    return { transport: this.name, id: result.MessageId }
  }

  /** The `SendEmail` request body. */
  private async payload(message: SentMessage): Promise<Record<string, unknown>> {
    const raw = message.attachments.length > 0

    return {
      FromEmailAddress: formatAddress(message.from),
      ...(this.options.fromArn ? { FromEmailAddressIdentityArn: this.options.fromArn } : {}),
      Destination: {
        ToAddresses: message.to.map(formatAddress),
        ...(message.cc.length > 0 ? { CcAddresses: message.cc.map(formatAddress) } : {}),
        ...(message.bcc.length > 0 ? { BccAddresses: message.bcc.map(formatAddress) } : {})
      },
      ...(message.replyTo.length > 0
        ? { ReplyToAddresses: message.replyTo.map(formatAddress) }
        : {}),
      ...(this.options.configurationSet
        ? { ConfigurationSetName: this.options.configurationSet }
        : {}),
      /**
       * Tags travel as `EmailTags`, which SES requires to be a name and a value.
       * A bare tag becomes its own name with an empty value rather than being
       * dropped: a message that silently loses its tags is one nobody can report on.
       */
      ...(message.tags.length > 0
        ? { EmailTags: message.tags.map((name) => ({ Name: name, Value: '' })) }
        : {}),
      Content: raw
        ? { Raw: { Data: Buffer.from(await this.mime(message)).toString('base64') } }
        : {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
                ...(message.text ? { Text: { Data: message.text, Charset: 'UTF-8' } } : {})
              },
              ...(Object.keys(message.headers).length > 0
                ? {
                    Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                      Name,
                      Value
                    }))
                  }
                : {})
            }
          }
    }
  }

  /** The whole MIME document, for a message with attachments. */
  private async mime(message: SentMessage): Promise<Buffer> {
    const composer = new MailComposer({
      from: formatAddress(message.from),
      to: message.to.map(formatAddress),
      cc: message.cc.length > 0 ? message.cc.map(formatAddress) : undefined,
      bcc: message.bcc.length > 0 ? message.bcc.map(formatAddress) : undefined,
      replyTo: message.replyTo.length > 0 ? message.replyTo.map(formatAddress) : undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      attachments: message.attachments.map((file) => ({
        filename: file.filename,
        // nodemailer takes a Buffer or a string, not a bare Uint8Array.
        content: file.content instanceof Uint8Array ? Buffer.from(file.content) : file.content,
        path: file.path,
        contentType: file.contentType,
        cid: file.cid
      }))
    })

    return composer.compile().build()
  }
}
