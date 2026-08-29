import type { AnyMailable, MailableClass } from './mailable.ts'
import type { MailManager } from './manager.ts'
import { escapeAttribute, escapeHtml } from './markdown.ts'

/**
 * Looking at a mail without sending one, and without a second service.
 *
 * Laravel's answer is one interface — `Mailable implements Renderable` — so a route
 * returning a mailable renders it. Catching the mail is somebody else's job there:
 * Mailpit, which is a container in `laravel/sail` rather than anything the framework
 * ships.
 *
 * This is that, plus the page Laravel leaves you to write. `MailServiceProvider`
 * already discovers every mailable in `app/Mail`, so the index has a list to show
 * without anybody registering anything; a mailable joins it by saying what a sample
 * of itself looks like:
 *
 * ```ts
 * export class InvoicePaid extends Mailable {
 *   static preview() {
 *     return new InvoicePaid({ number: 'INV-001', total: 1200 })
 *   }
 * }
 * ```
 *
 * Return an array to show several — an invoice paid and one overdue read very
 * differently, and the second is the one nobody checks.
 */
export type Previewable = MailableClass & {
  preview?: () => AnyMailable | AnyMailable[]
}

/** The samples a mailable offers, normalised. */
function samplesOf(mailable: Previewable): AnyMailable[] {
  if (typeof mailable.preview !== 'function') return []

  const sample = mailable.preview()

  return Array.isArray(sample) ? sample : [sample]
}

/** Every discovered mailable that offers a sample, with how many it offers. */
export function previewable(manager: MailManager): Array<{ name: string; samples: number }> {
  const found: Array<{ name: string; samples: number }> = []

  for (const mailable of manager.mailables.all() as Previewable[]) {
    const samples = samplesOf(mailable).length

    if (samples > 0) found.push({ name: mailable.name, samples })
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The rendered mail, as a response.
 *
 * `manager.mailer().render()` is what does the work, and it inlines `cid:` images as
 * data URIs on the way out — a browser has none of the message's attachments, so
 * without that every embedded image here is a broken one and the person checking the
 * design cannot tell that from an image that is genuinely missing.
 */
export async function renderPreview(
  manager: MailManager,
  mailable: AnyMailable
): Promise<Response> {
  return new Response(await manager.mailer().render(mailable), {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

const PAGE = `body{margin:0;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#17150f;background:#fbf9f5}
a{color:#c9241a}header{padding:20px 24px;border-bottom:1px solid #ddd7c9}
h1{margin:0;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#6f6a5d}
main{display:grid;grid-template-columns:260px 1fr;min-height:calc(100dvh - 61px)}
nav{padding:16px 0;border-right:1px solid #ddd7c9;overflow-y:auto}
nav a{display:block;padding:7px 24px;text-decoration:none;color:#17150f;font-size:14px}
nav a:hover{background:#fff}nav a[aria-current]{background:#fff;font-weight:600}
nav p{margin:16px 24px 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6f6a5d}
iframe{width:100%;height:100%;border:0;background:#fff}
.empty{padding:48px 24px;color:#6f6a5d;max-width:40rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#fff;padding:1px 5px;border-radius:4px;border:1px solid #ddd7c9}`

/** The index, with the chosen mail in a frame beside it. */
function page(
  base: string,
  entries: Array<{ name: string; samples: number }>,
  current: { name: string; index: number } | undefined
): string {
  if (entries.length === 0) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mail preview</title><style>${PAGE}</style></head><body><header><h1>Mail preview</h1></header><div class="empty"><p>No mailable in <code>app/Mail</code> offers a sample yet.</p><p>Add a static <code>preview()</code> that returns an instance, and it appears here:</p><pre><code>static preview() {
  return new InvoicePaid({ number: 'INV-001' })
}</code></pre></div></body></html>`
  }

  const links = entries
    .map((entry) => {
      const items = Array.from({ length: entry.samples }, (_, index) => {
        const href = `${base}?mailable=${encodeURIComponent(entry.name)}&sample=${index}`
        const chosen = current?.name === entry.name && current.index === index
        const label = entry.samples === 1 ? entry.name : `${entry.name} ${index + 1}`

        return `<a href="${escapeAttribute(href)}"${chosen ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`
      })

      return items.join('')
    })
    .join('')

  const frame =
    current === undefined
      ? '<div class="empty"><p>Pick a mail on the left.</p></div>'
      : `<iframe title="preview" src="${escapeAttribute(
          `${base}?mailable=${encodeURIComponent(current.name)}&sample=${current.index}&raw=1`
        )}"></iframe>`

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mail preview</title><style>${PAGE}</style></head><body><header><h1>Mail preview</h1></header><main><nav><p>app/Mail</p>${links}</nav>${frame}</main></body></html>`
}

/**
 * Answer a preview request — the index, or one rendered mail.
 *
 * `raw=1` is what the frame asks for, and it is the same URL the index links to so
 * that opening a mail in its own tab needs no second route. Returns `undefined` when
 * the request is for something else, so the caller can pass it on.
 */
export async function handlePreview(
  manager: MailManager,
  request: Request,
  base: string
): Promise<Response | undefined> {
  const url = new URL(request.url)

  if (url.pathname !== base) return undefined

  const entries = previewable(manager)
  const wanted = url.searchParams.get('mailable')

  if (wanted === null) return html(page(base, entries, undefined))

  const mailable = (manager.mailables.get(wanted) ?? undefined) as Previewable | undefined
  const samples = mailable === undefined ? [] : samplesOf(mailable)
  const index = Number(url.searchParams.get('sample') ?? 0)
  const chosen = samples[Number.isInteger(index) && index >= 0 ? index : 0]

  if (chosen === undefined) return html(page(base, entries, undefined), 404)

  if (url.searchParams.get('raw') === '1') return renderPreview(manager, chosen)

  return html(page(base, entries, { name: wanted, index }))
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}
