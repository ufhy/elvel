import type { Attachment, Content, Envelope } from '@elysian/mail'
import { Mailable } from '@elysian/mail'

/**
 * An invoice, with the PDF read off a storage disk and a logo embedded.
 *
 * Generated with `bun run playground make:mail InvoiceMail`, then extended.
 *
 * The attachment is resolved before the mailable is built — `attachments()` is
 * synchronous, and the bytes have to be in hand by then. That is deliberate: a
 * mailable that reads a disk while being built would do so again on every retry
 * of a queued send, against a file that may have moved.
 */
export class InvoiceMail extends Mailable<{ name: string; reference: string }> {
  private files: Attachment[] = []

  /** Hand it the attachments read from a disk. */
  withFiles(files: Attachment[]): this {
    this.files = files

    return this
  }

  envelope(): Envelope {
    return {
      to: 'ada@example.com',
      subject: `Invoice ${this.data.reference}`
    }
  }

  content(): Content {
    return {
      html: `<p>Hello ${this.data.name}, your invoice is attached.</p><img src="cid:logo">`,
      text: `Hello ${this.data.name}, your invoice is attached.`
    }
  }

  override attachments(): Attachment[] {
    return this.files
  }
}
