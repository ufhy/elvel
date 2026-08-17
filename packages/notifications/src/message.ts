import type { ViewComponent } from '@elvel/contracts'

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

  attach(attachment: MailAttachment): this {
    this.files.push(attachment)

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

    return this
  }

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
  toHtml(appName: string): string {
    const accent =
      this.levelName === 'error' ? '#dc2626' : this.levelName === 'success' ? '#16a34a' : '#2563eb'

    const paragraph = (text: string) =>
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#111;">${escapeHtml(text)}</p>`

    const body: string[] = [
      `<h1 style="margin:0 0 16px;font-size:20px;color:#111;">${escapeHtml(
        this.greetingLine ?? (this.levelName === 'error' ? 'Whoops!' : 'Hello!')
      )}</h1>`,
      ...this.introLines.map(paragraph)
    ]

    if (this.actionText && this.actionUrl) {
      body.push(
        `<p style="margin:0 0 24px;"><a href="${escapeAttribute(this.actionUrl)}" style="display:inline-block;padding:10px 18px;background:${accent};color:#fff;border-radius:6px;text-decoration:none;font-size:15px;">${escapeHtml(this.actionText)}</a></p>`
      )
    }

    body.push(...this.outroLines.map(paragraph))

    body.push(
      `<p style="margin:24px 0 0;font-size:14px;color:#555;">${escapeHtml(
        this.salutationLine ?? `Regards, ${appName}`
      )}</p>`
    )

    return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"><div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:10px;">${body.join('')}</div></body></html>`
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
