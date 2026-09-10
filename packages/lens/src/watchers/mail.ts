import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

type Mailbox = { address: string; name?: string }

/**
 * Records each message sent, with enough of it to preview.
 *
 * The body is recorded, which Telescope also does and which is the point: the
 * question about a transactional email is almost always "what did it actually
 * look like", and a row naming the subject cannot answer it. So an email's
 * contents live in the recorder, and everything an email contains — a password
 * reset link, an invoice, an address — lives there with it.
 *
 * `bodyLimit` is the one addition. Telescope keeps the whole body and the raw
 * MIME message besides; a marketing send with inlined images would put
 * megabytes in a row per recipient, so the body is dropped past a limit rather
 * than truncated, the way the request watcher treats a response.
 */
export class MailWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('mail.sent', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const message = payload.message as Record<string, unknown> | undefined

    if (message === undefined) return

    const html = typeof message.html === 'string' ? message.html : undefined
    const text = typeof message.text === 'string' ? message.text : undefined

    lens.record(
      EntryType.MAIL,
      IncomingEntry.make({
        mailable: message.mailable ?? null,
        mailer: payload.mailer ?? null,
        from: addresses(message.from),
        to: addresses(message.to),
        cc: addresses(message.cc),
        bcc: addresses(message.bcc),
        replyTo: addresses(message.replyTo),
        subject: message.subject ?? null,
        html: this.body(html),
        text: this.body(text),
        attachments: Array.isArray(message.attachments) ? message.attachments.length : 0
      }).withTags(recipients(message))
    )
  }

  /** Kilobytes, Telescope's arithmetic — whole kilobytes, at or under the limit. */
  private body(content: string | undefined): string | null {
    if (content === undefined) return null

    return Math.trunc(content.length / 1000) <= this.option('bodyLimit', 128)
      ? content
      : 'Purged By Lens'
  }
}

/** `Name <address>` when there is a name, the address alone when there is not. */
function addresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]

  return list.map((entry) => {
    const mailbox = entry as Mailbox

    if (typeof mailbox?.address !== 'string') return String(entry)

    return mailbox.name === undefined ? mailbox.address : `${mailbox.name} <${mailbox.address}>`
  })
}

/**
 * One tag per recipient, so a support request becomes "show me everything sent
 * to this person" rather than a scan of every message.
 */
function recipients(message: Record<string, unknown>): string[] {
  const found: string[] = []

  for (const field of ['to', 'cc', 'bcc']) {
    for (const entry of (message[field] as Mailbox[] | undefined) ?? []) {
      if (typeof entry?.address === 'string') found.push(entry.address)
    }
  }

  return [...new Set(found)]
}
