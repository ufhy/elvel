import type { ViewComponent } from '@elvel/contracts'
import {
  button,
  emailLayout,
  heading,
  inlineTheme,
  type MailLayout,
  paragraph,
  salutation
} from '@elvel/mail'

export type MailAttachment = {
  filename: string
  content?: string | Uint8Array
  path?: string
  contentType?: string
}

/**
 * The mail a notification sends — Laravel's `MailMessage`.
 *
 * The fluent form is the point: most notifications are a greeting, a line or two,
 * one button and a sign-off, and writing that as a template every time is worse
 * than describing it. `view()` hands the whole body over to one of the
 * application's own JSX components when the default is not enough.
 */
export class MailMessage {
  private subjectLine: string | undefined
  private ccList: string[] = []
  private bccList: string[] = []
  private tagList: string[] = []
  private metadataPairs: Record<string, string> = {}
  private priorityLevel: number | undefined
  private greetingLine: string | undefined
  private salutationLine: string | undefined
  private readonly introLines: string[] = []
  private readonly outroLines: string[] = []
  private actionText: string | undefined
  private actionUrl: string | undefined
  private levelName: 'info' | 'success' | 'error' = 'info'
  private readonly files: MailAttachment[] = []
  private component: { view: ViewComponent<never>; with: unknown } | undefined
  private fromAddress: { address: string; name?: string } | undefined
  private replyToAddress: string | undefined

  subject(subject: string): this {
    this.subjectLine = subject

    return this
  }

  greeting(greeting: string): this {
    this.greetingLine = greeting

    return this
  }

  salutation(salutation: string): this {
    this.salutationLine = salutation

    return this
  }

  /**
   * A paragraph.
   *
   * Lines added before `action()` appear above the button and lines after it
   * below, which is how Laravel's template reads and why the order is kept.
   */
  line(line: string): this {
    if (this.actionText === undefined) this.introLines.push(line)
    else this.outroLines.push(line)

    return this
  }

  lines(lines: string[]): this {
    for (const line of lines) this.line(line)

    return this
  }

  /** The one button. A second call replaces the first. */
  action(text: string, url: string): this {
    this.actionText = text
    this.actionUrl = url

    return this
  }

  success(): this {
    this.levelName = 'success'

    return this
  }

  error(): this {
    this.levelName = 'error'

    return this
  }

  from(address: string, name?: string): this {
    this.fromAddress = { address, name }

    return this
  }

  replyTo(address: string): this {
    this.replyToAddress = address

    return this
  }

  /**
   * A copy, and a blind copy — Laravel's `cc` and `bcc` on `MailMessage`.
   *
   * These were on `@elvel/mail`'s `Envelope` and not here, so a notification could
   * be sent to one address and no other. The commonest reason to want them is an
   * audit box that has to see what a customer was told.
   */
  cc(address: string | string[]): this {
    this.ccList.push(...(Array.isArray(address) ? address : [address]))

    return this
  }

  bcc(address: string | string[]): this {
    this.bccList.push(...(Array.isArray(address) ? address : [address]))

    return this
  }

  /** A label the transport passes on, for grouping in an analytics dashboard. */
  tag(value: string): this {
    this.tagList.push(value)

    return this
  }

  /** A key the transport carries back on a delivery event — an order id, usually. */
  metadata(key: string, value: string): this {
    this.metadataPairs[key] = value

    return this
  }

  /** `1` is highest and `5` lowest, as `X-Priority` reads. */
  priority(level: number): this {
    this.priorityLevel = level

    return this
  }

  /**
   * A line only when the condition holds — Laravel's `lineIf`.
   *
   * Worth having for the reason `when` is: without it the fluent chain has to be
   * broken by an `if`, and the message is then built in two shapes that drift.
   */
  lineIf(condition: boolean, line: string): this {
    return condition ? this.line(line) : this
  }

  linesIf(condition: boolean, lines: string[]): this {
    return condition ? this.lines(lines) : this
  }

  /**
   * Run `body` when the condition holds, and keep the chain — Laravel's `when`.
   *
   * The callback may return the message or nothing; either way the chain continues
   * from this message, which is what Laravel's own test pins.
   */
  when(condition: boolean, body: (message: this) => unknown): this {
    if (condition) body(this)

    return this
  }

  /** The other side of `when`. */
  unless(condition: boolean, body: (message: this) => unknown): this {
    if (!condition) body(this)

    return this
  }

  /** Every copied address, for whoever builds the envelope. */
  get copies(): { cc: string[]; bcc: string[] } {
    return { cc: [...this.ccList], bcc: [...this.bccList] }
  }

  /** The labels and keys a transport carries, and the priority if one was set. */
  get delivery(): {
    tags: string[]
    metadata: Record<string, string>
    priority: number | undefined
  } {
    return {
      tags: [...this.tagList],
      metadata: { ...this.metadataPairs },
      priority: this.priorityLevel
    }
  }

  attach(attachment: MailAttachment): this {
    this.files.push(attachment)

    return this
  }

  /** Several at once — what a receipt with a per-item file needs. */
  attachMany(attachments: MailAttachment[]): this {
    this.files.push(...attachments)

    return this
  }

  /**
   * Write the body as markdown instead of as lines.
   *
   * The builder covers a greeting, some lines and a button, which is most
   * notifications. A release note or a summary is not that shape, and expressing
   * it as twelve `.line()` calls loses the structure the reader needs — a list
   * stays a list here.
   *
   * Rendered by the mail package's own renderer, so the two produce the same
   * inline-styled HTML and a notification does not look different from a
   * mailable written the same way.
   */
  markdown(source: string): this {
    this.markdownBody = source
    // The two are alternatives, so the later call wins rather than being quietly
    // outranked — Laravel clears the other for the same reason.
    this.component = undefined

    return this
  }

  private markdownBody: string | undefined

  /** The markdown body, when one was set. */
  get markdownSource(): string | undefined {
    return this.markdownBody
  }

  /** Render the body with one of the application's components instead. */
  view<Props>(component: ViewComponent<Props>, props: Props): this {
    this.component = { view: component as ViewComponent<never>, with: props }
    this.markdownBody = undefined

    return this
  }

  /**
   * Wrap the body in a document of your own — Laravel's `template()`.
   *
   * The default is a card on a grey page, which is a safe answer and not every
   * brand's answer. A layout takes the rendered parts and the colours and returns
   * the whole document, which is the same shape `emailLayout` has, so the default
   * can be called from inside a replacement that only adds a header.
   */
  template(layout: MailLayout): this {
    this.layoutFn = layout

    return this
  }

  private layoutFn: MailLayout | undefined

  /**
   * Write the plain-text half yourself.
   *
   * Generated from the same lines otherwise, which is right for a built message and
   * wrong for a markdown or component body: a table rendered as text is a wall, and
   * whoever wrote it knows what it should say.
   */
  text(body: string): this {
    this.textBody = body

    return this
  }

  private textBody: string | undefined

  // ------------------------------------------------------------------ reading

  get level(): 'info' | 'success' | 'error' {
    return this.levelName
  }

  get attachments(): MailAttachment[] {
    return [...this.files]
  }

  get sender(): { address: string; name?: string } | undefined {
    return this.fromAddress
  }

  get replyToOrUndefined(): string | undefined {
    return this.replyToAddress
  }

  get viewComponent(): { view: ViewComponent<never>; with: unknown } | undefined {
    return this.component
  }

  /** The plain-text half, when it was written rather than generated. */
  get textOrUndefined(): string | undefined {
    return this.textBody
  }

  /** The document to wrap the body in, when one was named. */
  get layout(): MailLayout | undefined {
    return this.layoutFn
  }

  /** The subject, or something reasonable derived from the notification's name. */
  subjectOr(fallback: string): string {
    return this.subjectLine ?? fallback
  }

  /**
   * The message as plain text.
   *
   * Not an afterthought: a mail with no text part is more likely to be treated as
   * spam, and some clients still prefer it.
   */
  toText(appName: string): string {
    if (this.textBody !== undefined) return this.textBody

    const parts: string[] = []

    parts.push(this.greetingLine ?? (this.levelName === 'error' ? 'Whoops!' : 'Hello!'))
    parts.push(...this.introLines)

    if (this.actionText && this.actionUrl) parts.push(`${this.actionText}: ${this.actionUrl}`)

    parts.push(...this.outroLines)
    parts.push(this.salutationLine ?? `Regards,\n${appName}`)

    return parts.join('\n\n')
  }

  /**
   * The message as HTML.
   *
   * Built here rather than from a template file, and inline-styled, because a mail
   * client ignores most of a stylesheet and half of them ignore `<style>`
   * entirely. Every interpolated value is escaped: a notification line often
   * carries a name or a title that came from a user.
   */
  /**
   * The mail, built from `@elvel/mail`'s components rather than from strings here.
   *
   * This markup used to live in this file, which meant a `Mailable` had no way to
   * reach it: `markdownContent()` returned bare tags with no layout and no button,
   * so the good template only existed for notifications. It belongs to the package
   * that owns mail, and this reads it like any other caller.
   */
  toHtml(appName: string, theme?: string, layout?: MailLayout): string {
    const tone =
      this.levelName === 'error' ? 'error' : this.levelName === 'success' ? 'success' : 'info'

    const parts: string[] = [
      heading(this.greetingLine ?? (this.levelName === 'error' ? 'Whoops!' : 'Hello!')),
      ...this.introLines.map((line) => paragraph(line))
    ]

    if (this.actionText && this.actionUrl) {
      parts.push(button(this.actionText, this.actionUrl, tone))
    }

    parts.push(...this.outroLines.map((line) => paragraph(line)))
    parts.push(salutation(this.salutationLine ?? `Regards, ${appName}`))

    // The message's own `template()` first: an explicit instruction beats the
    // application-wide default, which is what `mail.layout` is.
    const html = (this.layoutFn ?? layout ?? emailLayout)(parts)

    return inlineTheme(html, theme)
  }
}

/** Escape text going into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Escape a URL going into an attribute.
 *
 * A `javascript:` URL in a mail is mostly harmless — clients do not run it — but a
 * quote would break out of the attribute, and the same string is often reused in a
 * web view where the scheme does matter.
 */
export function escapeAttribute(value: string): string {
  const safe = /^(https?:|mailto:|\/)/i.test(value.trim()) ? value : '#'

  return escapeHtml(safe)
}
