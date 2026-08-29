import { escapeAttribute, escapeHtml, safeUrl } from './markdown.ts'

/**
 * The parts a transactional email is made of — Laravel's `mail::` components.
 *
 * Laravel ships these as Blade components rendered through a theme and then run
 * through a CSS inliner. These produce inline styles as they build, for the reason
 * `markdownToHtml` does: Gmail strips `<style>` blocks, so a stylesheet-driven
 * renderer looks right in a preview and unstyled in the inbox.
 *
 * They live in `@elvel/mail` rather than in `@elvel/notifications`, which is where
 * this markup used to be. A notification is one kind of mail and the layout is not
 * its property: an invoice built as a `Mailable` needs a button as much as a
 * password reset does, and before this move it could not have one — `markdownContent`
 * returned bare `<h1>`s and `<p>`s with nothing around them.
 */

/** The accent a message carries, which only its level decides. */
export type MailTone = 'info' | 'success' | 'error'

/**
 * The colours a mail is drawn in — Laravel's mail theme, as values rather than a
 * stylesheet.
 *
 * Laravel publishes a CSS file per theme and runs the result through an inliner.
 * These are the values themselves, for the reason the components inline as they
 * build: Gmail strips `<style>` blocks, so a stylesheet-driven mail looks right in
 * a preview and unstyled in the inbox. Naming them here means an application can
 * change its mail's colours without a copy of the markup.
 *
 * Passed rather than global. A module-level theme would be one mutable value shared
 * by every request, and a worker rendering two applications' mail is exactly where
 * that goes wrong.
 */
export type MailTheme = {
  /** Behind the card. */
  page: string
  /** The card itself. */
  card: string
  /** Body text and headings. */
  ink: string
  /** Small print and the salutation. */
  muted: string
  /** Rules and the subcopy divider. */
  line: string
  /** The button, by the message's level. */
  accent: Record<MailTone, string>
}

export const DEFAULT_THEME: MailTheme = {
  page: '#f6f7f9',
  card: '#ffffff',
  ink: '#111111',
  muted: '#555555',
  line: '#e5e5e5',
  accent: { info: '#2563eb', success: '#16a34a', error: '#dc2626' }
}

/** A heading, and the only one a message should have. */
export function heading(text: string, theme: MailTheme = DEFAULT_THEME): string {
  return `<h1 style="margin:0 0 16px;font-size:20px;color:${theme.ink};">${escapeHtml(text)}</h1>`
}

/** A paragraph of prose. */
export function paragraph(text: string, theme: MailTheme = DEFAULT_THEME): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${theme.ink};">${escapeHtml(text)}</p>`
}

/**
 * The call to action, and there is one per message on purpose.
 *
 * A second button competes with the first, and a transactional mail that asks two
 * things gets neither done. Laravel's template takes the same position.
 */
export function button(
  text: string,
  url: string,
  tone: MailTone = 'info',
  theme: MailTheme = DEFAULT_THEME
): string {
  return `<p style="margin:0 0 24px;"><a href="${escapeAttribute(safeUrl(url))}" style="display:inline-block;padding:10px 18px;background:${theme.accent[tone]};color:${theme.card};border-radius:6px;text-decoration:none;font-size:15px;">${escapeHtml(text)}</a></p>`
}

/** A block set apart from the prose — Laravel's `mail::panel`. */
export function panel(text: string, theme: MailTheme = DEFAULT_THEME): string {
  return `<div style="margin:0 0 16px;padding:16px;background:${theme.page};border-radius:8px;font-size:15px;line-height:1.6;color:${theme.ink};">${escapeHtml(text)}</div>`
}

/**
 * The small print under the button — Laravel's `mail::subcopy`.
 *
 * What it is usually for: repeating the action's URL as text, because a mail client
 * that will not render a button still has to let somebody reach the page.
 */
export function subcopy(text: string, theme: MailTheme = DEFAULT_THEME): string {
  return `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${theme.line};font-size:13px;line-height:1.6;color:${theme.muted};word-break:break-all;">${escapeHtml(text)}</p>`
}

/** The closing line. */
export function salutation(text: string, theme: MailTheme = DEFAULT_THEME): string {
  return `<p style="margin:24px 0 0;font-size:14px;color:${theme.muted};">${escapeHtml(text)}</p>`
}

/**
 * The document every mail is wrapped in.
 *
 * A table would survive more clients than a `<div>` does, and this does not use one:
 * the layout is a single centred column with no columns to hold together, which is
 * the one case where `max-width` and `margin:0 auto` are enough everywhere that
 * matters. What it does carry is the outer background — a card on a tinted page
 * reads as a message rather than as a document, and clients that ignore the outer
 * colour simply show white.
 *
 * `parts` are already-rendered strings rather than values to escape, because that is
 * what the components above hand back. Nothing here escapes anything a second time.
 */
export function emailLayout(parts: string[], theme: MailTheme = DEFAULT_THEME): string {
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:24px;background:${theme.page};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"><div style="max-width:560px;margin:0 auto;padding:24px;background:${theme.card};border-radius:10px;">${parts.join('')}</div></body></html>`
}

/**
 * A theme with only what an application named changed.
 *
 * Applications override a colour or two — an accent to match a brand — and naming
 * every value to change one is how the rest silently stop following the default.
 */
export function themeFrom(overrides: Partial<MailTheme> | undefined): MailTheme {
  if (overrides === undefined) return DEFAULT_THEME

  return {
    ...DEFAULT_THEME,
    ...overrides,
    accent: { ...DEFAULT_THEME.accent, ...(overrides.accent ?? {}) }
  }
}
