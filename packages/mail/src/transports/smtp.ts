import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { formatAddress } from '../mailable.ts'
import type { DeliveryResult, SentMessage, Transport } from '../message.ts'

export type SmtpOptions = {
  host: string
  port?: number
  /** True for implicit TLS (port 465). STARTTLS is negotiated automatically. */
  secure?: boolean
  username?: string
  password?: string
  /** Milliseconds before giving up on the connection. */
  timeout?: number
  /** Keep a connection open across sends. */
  pool?: boolean
  /**
   * Accept a certificate that does not verify.
   *
   * For a local mail catcher with a self-signed certificate, and nothing else:
   * turning this on means anyone between here and the mail server can read the
   * mail and change it. The manager refuses to honour it in production — see
   * `MailManager.build()` — so it cannot reach a real server by accident. The
   * better fix for a real server is a properly issued certificate, or the local
   * CA added to the trust store.
   */
  allowSelfSigned?: boolean
}

/**
 * SMTP, through nodemailer.
 *
 * Delegated rather than written here, and deliberately so: sending mail is an SMTP
 * state machine *and* a MIME encoder — dot-stuffing, header folding, RFC 2047
 * words for non-ASCII names, quoted-printable, multipart boundaries. Every one of
 * those is a place where a subtle bug means mail that silently lands in spam.
 * Laravel delegates the same work to Symfony Mailer for the same reason.
 *
 * What stays here is the translation: our resolved message in, nodemailer's shape
 * out, and one error type on the way back.
 */
export class SmtpTransport implements Transport {
  readonly name = 'smtp'

  private transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | undefined

  constructor(private readonly options: SmtpOptions) {}

  async send(message: SentMessage): Promise<DeliveryResult> {
    const sent = await this.transport().sendMail({
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

    return { transport: this.name, id: sent.messageId }
  }

  /** Prove the server is reachable and the credentials work. */
  async verify(): Promise<boolean> {
    return this.transport().verify()
  }

  close(): void {
    this.transporter?.close()
    this.transporter = undefined
  }

  /** Built on first use, so configuring a mailer never opens a connection. */
  private transport(): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
    if (this.transporter) return this.transporter

    /**
     * Pooling changes the options type *and* the reported result type in
     * `@types/nodemailer`, and the two are not assignable to each other. Both are
     * valid arguments to `createTransport`, and the only field read back is
     * `messageId`, which both carry — so the union is assembled here and narrowed
     * once, rather than threading two transporter types through the class.
     */
    const options: SMTPTransport.Options & { pool?: boolean } = {
      host: this.options.host,
      port: this.options.port ?? 587,
      secure: this.options.secure ?? (this.options.port ?? 587) === 465,
      connectionTimeout: this.options.timeout ?? 10_000,
      greetingTimeout: this.options.timeout ?? 10_000,
      auth:
        this.options.username === undefined
          ? undefined
          : { user: this.options.username, pass: this.options.password ?? '' },
      // Off by default: a mail server presenting a certificate nobody checks is
      // an open invitation to read the mail in transit.
      tls: this.options.allowSelfSigned ? { rejectUnauthorized: false } : undefined
    }

    if (this.options.pool) options.pool = true

    this.transporter = nodemailer.createTransport(
      options
    ) as nodemailer.Transporter<SMTPTransport.SentMessageInfo>

    return this.transporter
  }
}
