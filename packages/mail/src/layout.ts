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

const ACCENT: Record<MailTone, string> = {
  info: '#2563eb',
  success: '#16a34a',
  error: '#dc2626'
}

/** A heading, and the only one a message should have. */
export function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:20px;color:#111;">${escapeHtml(text)}</h1>`
}

/** A paragraph of prose. */
export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#111;">${escapeHtml(text)}</p>`
}

/**
 * The call to action, and there is one per message on purpose.
 *
 * A second button competes with the first, and a transactional mail that asks two
 * things gets neither done. Laravel's template takes the same position.
 */
export function button(text: string, url: string, tone: MailTone = 'info'): string {
  return `<p style="margin:0 0 24px;"><a href="${escapeAttribute(safeUrl(url))}" style="display:inline-block;padding:10px 18px;background:${ACCENT[tone]};color:#fff;border-radius:6px;text-decoration:none;font-size:15px;">${escapeHtml(text)}</a></p>`
}

/** A block set apart from the prose — Laravel's `mail::panel`. */
export function panel(text: string): string {
  return `<div style="margin:0 0 16px;padding:16px;background:#f6f7f9;border-radius:8px;font-size:15px;line-height:1.6;color:#111;">${escapeHtml(text)}</div>`
}

/**
 * The small print under the button — Laravel's `mail::subcopy`.
 *
 * What it is usually for: repeating the action's URL as text, because a mail client
 * that will not render a button still has to let somebody reach the page.
 */
export function subcopy(text: string): string {
  return `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;font-size:13px;line-height:1.6;color:#555;word-break:break-all;">${escapeHtml(text)}</p>`
}

/** The closing line. */
export function salutation(text: string): string {
  return `<p style="margin:24px 0 0;font-size:14px;color:#555;">${escapeHtml(text)}</p>`
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
export function emailLayout(parts: string[]): string {
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"><div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:10px;">${parts.join('')}</div></body></html>`
}
