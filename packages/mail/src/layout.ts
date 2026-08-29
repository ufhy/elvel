import { escapeAttribute, escapeHtml, safeUrl } from './markdown.ts'

/**
 * The parts a transactional email is made of — Laravel's `mail::` components.
 *
 * They carry class names and nothing else, the way Laravel's Blade components do.
 * What styles them is the theme stylesheet, applied by `inlineTheme()` once the
 * whole message is built. These used to interpolate a token object into `style`
 * attributes as they built, which put the inlining in the hand of whoever wrote the
 * markup and left anything the tokens did not name unchangeable.
 *
 * They live in `@elvel/mail` rather than in `@elvel/notifications`, which is where
 * this markup used to be. A notification is one kind of mail and the layout is not
 * its property: an invoice built as a `Mailable` needs a button as much as a
 * password reset does, and before that move it could not have one — `markdownContent`
 * returned bare `<h1>`s and `<p>`s with nothing around them.
 */

/** The accent a message carries, which only its level decides. */
export type MailTone = 'info' | 'success' | 'error'

/** A heading, and the only one a message should have. */
export function heading(text: string): string {
  return `<h1>${escapeHtml(text)}</h1>`
}

/** A paragraph of prose. */
export function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`
}

/**
 * The call to action, and there is one per message on purpose.
 *
 * A second button competes with the first, and a transactional mail that asks two
 * things gets neither done. Laravel's template takes the same position.
 */
export function button(text: string, url: string, tone: MailTone = 'info'): string {
  return `<p class="action"><a href="${escapeAttribute(safeUrl(url))}" class="button button--${tone}">${escapeHtml(text)}</a></p>`
}

/** A block set apart from the prose — Laravel's `mail::panel`. */
export function panel(text: string): string {
  return `<div class="panel">${escapeHtml(text)}</div>`
}

/**
 * The small print under the button — Laravel's `mail::subcopy`.
 *
 * What it is usually for: repeating the action's URL as text, because a mail client
 * that will not render a button still has to let somebody reach the page.
 */
export function subcopy(text: string): string {
  return `<p class="subcopy">${escapeHtml(text)}</p>`
}

/** The closing line. */
export function salutation(text: string): string {
  return `<p class="salutation">${escapeHtml(text)}</p>`
}

/**
 * What wraps a rendered body — `emailLayout` is the one every mail gets by default.
 *
 * A type of its own so an application can supply another: the default is a card on
 * a tinted page, which is the safe answer and not every brand's answer. Laravel
 * calls the same swap `template()`.
 */
export type MailLayout = (parts: string[]) => string

/**
 * The document every mail is wrapped in.
 *
 * A table would survive more clients than a `<div>` does, and this does not use one:
 * the layout is a single centred column with no columns to hold together, which is
 * the one case where `max-width` and `margin:0 auto` are enough everywhere that
 * matters.
 *
 * The `<style>` block holds the one rule that cannot become a `style` attribute.
 * Laravel's layout carries the same two media queries for the same reason, and a
 * client that drops the block loses only a width override.
 *
 * `parts` are already-rendered strings rather than values to escape, because that is
 * what the components above hand back. Nothing here escapes anything a second time.
 */
export function emailLayout(parts: string[]): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><style>@media only screen and (max-width: 600px) { .card { width: 100% !important; padding: 16px !important; } .button { display: block !important; text-align: center !important; } }</style></head><body><div class="card">${parts.join('')}</div></body></html>`
}
