import type { ViewComponent } from '@elvel/contracts'
import { markdownToHtml, markdownToText } from './markdown.ts'

/** One mailbox. A bare string is an address with no display name. */
export type Address = string | { address: string; name?: string }

/** Normalise whatever a caller gave us into a list of mailboxes. */
export function addresses(value: Address | Address[] | undefined): Array<{
  address: string
  name?: string
}> {
  if (value === undefined) return []

  return (Array.isArray(value) ? value : [value]).map((entry) =>
    typeof entry === 'string' ? { address: entry } : entry
  )
}

/** `Name <address>`, which is what both SMTP and the HTTP APIs want. */
export function formatAddress(mailbox: { address: string; name?: string }): string {
  if (!mailbox.name) return mailbox.address

  // Quoted so a comma or a colon in the name cannot break the header.
  return `"${mailbox.name.replaceAll('"', '\\"')}" <${mailbox.address}>`
}

/** Who the message is from and to — Laravel's `Mailables\Envelope`. */
export type Envelope = {
  from?: Address
  to?: Address | Address[]
  cc?: Address | Address[]
  bcc?: Address | Address[]
  replyTo?: Address | Address[]
  subject?: string
  /** Passed through to transports that understand them. */
  tags?: string[]
  metadata?: Record<string, string>
  headers?: Record<string, string>
}

/**
 * What the message says — Laravel's `Mailables\Content`.
 *
 * A view is one of our JSX components with its props. The pairing is checked by
 * `viewContent()` rather than by this type: a method that returns
 * `Content<Props>` would force every mailable to agree on one props type, and
 * erasing it here is what lets each mailable have its own while still being
 * checked where it is built.
 *
 * There is no second template engine — mail renders through exactly what the web
 * views render through.
 */
export type Content =
  | { view: ViewComponent<never>; with: unknown; text?: string }
  | { html: string; text?: string }
  | { text: string }

/**
 * Content from a view component and its props.
 *
 * ```ts
 * content() {
 *   return viewContent(ArticleMail, { title: this.data.title }, 'plain text')
 * }
 * ```
 *
 * A missing or misspelled prop is a compile error here, at the call site, which is
 * the only place that can know what the component wants.
 */
export function viewContent<Props>(
  view: ViewComponent<Props>,
  props: Props,
  text?: string
): Content {
  return { view: view as ViewComponent<never>, with: props, text }
}

/** A file to attach. */
export type Attachment = {
  filename: string
  /** Bytes, or a path to read them from. */
  content?: string | Uint8Array
  path?: string
  contentType?: string
  /** Set to embed the file in the HTML with `cid:<id>`. */
  cid?: string
}

/**
 * A message worth sending — Laravel's `Mailable`.
 *
 * ```ts
 * export class ArticlePublished extends Mailable<{ title: string }> {
 *   envelope() {
 *     return { subject: `Published: ${this.data.title}` }
 *   }
 *
 *   content() {
 *     return { view: ArticleMail, with: { title: this.data.title } }
 *   }
 * }
 * ```
 *
 * `data` is the constructor argument, as with a queued job — and for the same
 * reason: a mailable can be queued, and then only its data travels.
 */
export abstract class Mailable<TData = Record<string, never>> {
  constructor(readonly data: TData) {}

  abstract envelope(): Envelope

  abstract content(): Content

  /** Files to attach. Empty by default. */
  attachments(): Attachment[] {
    return []
  }

  /** Queue this mailable on this connection, when queued. */
  static connection: string | undefined

  /** Queue this mailable on this queue, when queued. */
  static queue: string | undefined
}

/**
 * Any mailable, whatever data it carries.
 *
 * `unknown` rather than `never`: `data` is only ever read, so `Mailable<{ id }>`
 * is assignable to `Mailable<unknown>` — which is what lets `send()` take a
 * mailable of any shape.
 */
export type AnyMailable = Mailable<unknown>

/** A mailable class, as the registry holds it. */
export type MailableClass = new (data: never) => AnyMailable

/**
 * Content written as markdown — Laravel's markdown mailables.
 *
 * ```ts
 * content() {
 *   return markdownContent(`
 *     # Your order shipped
 *
 *     It is on its way. [Track it](${this.data.url}).
 *   `)
 * }
 * ```
 *
 * Produces both parts: HTML for the client that wants it, and the markdown
 * itself as the text alternative — which is the reason to write mail this way,
 * since the text part stays readable instead of being tags stripped out of the
 * HTML.
 */
export function markdownContent(source: string): Content {
  const trimmed = dedent(source)

  return { html: markdownToHtml(trimmed), text: markdownToText(trimmed) }
}

/**
 * Remove the indentation a template literal picks up from its surroundings.
 *
 * Without it every line of a mail written inside a class body starts four
 * spaces in, which markdown reads as a code block — so the whole message renders
 * as one grey box.
 */
function dedent(source: string): string {
  const lines = source.replace(/^\n/, '').replace(/\s+$/, '').split('\n')
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => (/^(\s*)/.exec(line)?.[1] ?? '').length)

  const shortest = indents.length > 0 ? Math.min(...indents) : 0

  return lines.map((line) => line.slice(shortest)).join('\n')
}
