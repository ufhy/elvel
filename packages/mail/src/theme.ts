import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import juice from 'juice'

/**
 * The stylesheet every mail is drawn with, and the inliner that applies it.
 *
 * Laravel's shape, and for Laravel's reason. Its components carry class names and
 * its themes are CSS files; `Markdown::render()` hands both to
 * `CssToInlineStyles::convert()` and what leaves is markup with `style` attributes.
 * The inlining is real and necessary — Gmail strips `<style>` blocks, so a mail
 * that relies on one looks right in a preview and unstyled in the inbox — but it
 * belongs at the end of rendering rather than in the hand of whoever writes the
 * markup. This module is that end.
 *
 * What it replaces here was a theme expressed as a token object, with every
 * component interpolating the values into `style` attributes as it built. It worked
 * and it was the wrong shape: changing how a mail looks meant writing TypeScript,
 * and anything the tokens did not name could not be changed at all.
 */

/**
 * The default theme.
 *
 * Deliberately small. Laravel's is 297 lines because it is a full responsive table
 * layout; this is a single centred column, which is the one case where a `div` with
 * `max-width` holds together everywhere that matters.
 */
export const DEFAULT_THEME_CSS = `
body {
  margin: 0;
  padding: 24px;
  background: #f6f7f9;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.card {
  max-width: 560px;
  margin: 0 auto;
  padding: 24px;
  background: #ffffff;
  border-radius: 10px;
}

h1, h2, h3, h4, h5, h6 {
  margin: 0 0 12px;
  color: #111111;
  font-weight: 600;
}

h1 { font-size: 24px; }
h2 { font-size: 20px; }
h3 { font-size: 18px; }
h4 { font-size: 16px; }
h5 { font-size: 15px; }
h6 { font-size: 14px; }

p {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.6;
  color: #333333;
}

ul, ol {
  margin: 0 0 16px;
  padding-left: 20px;
  font-size: 15px;
  line-height: 1.6;
  color: #333333;
}

blockquote {
  margin: 0 0 16px;
  padding: 8px 16px;
  border-left: 3px solid #d0d0d0;
  color: #555555;
  font-size: 15px;
}

pre {
  margin: 0 0 16px;
  padding: 12px;
  background: #f5f5f5;
  border-radius: 6px;
  font-size: 13px;
  overflow-x: auto;
}

code {
  background: #f0f0f0;
  padding: 1px 4px;
  border-radius: 3px;
}

pre code {
  background: transparent;
  padding: 0;
}

hr {
  border: none;
  border-top: 1px solid #e5e5e5;
  margin: 24px 0;
}

a { color: #2563eb; }

img { max-width: 100%; }

.button {
  display: inline-block;
  padding: 10px 18px;
  border-radius: 6px;
  color: #ffffff;
  text-decoration: none;
  font-size: 15px;
}

.button--info { background: #2563eb; }
.button--success { background: #16a34a; }
.button--error { background: #dc2626; }

.action { margin: 0 0 24px; }

.panel {
  margin: 0 0 16px;
  padding: 16px;
  background: #f6f7f9;
  border-radius: 8px;
  font-size: 15px;
  line-height: 1.6;
  color: #111111;
}

.subcopy {
  margin: 24px 0 0;
  padding-top: 16px;
  border-top: 1px solid #e5e5e5;
  font-size: 13px;
  line-height: 1.6;
  color: #555555;
  word-break: break-all;
}

.salutation {
  margin: 24px 0 0;
  font-size: 14px;
  color: #555555;
}
`

/**
 * The theme an application named, or the default.
 *
 * `mail.theme` is a path rather than the CSS itself, the way Laravel's is a view
 * name: a stylesheet is a file somebody edits with a stylesheet editor open, not a
 * string in a config module. Read once, at boot — a mail is rendered in a worker
 * thousands of times and the file will not have changed between two of them.
 */
export function resolveThemeCss(source: string | undefined, basePath: string): string {
  if (source === undefined) return DEFAULT_THEME_CSS

  const path = isAbsolute(source) ? source : join(basePath, source)

  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `The mail theme [${source}] could not be read. mail.theme is a path to a CSS file, relative to the application root — bun elvel mail:theme writes a copy of the default one to edit.`
    )
  }
}

/**
 * Put the stylesheet into the markup, which is the only place a mail client reads it.
 *
 * `juice` rather than `css-inline`, and the reason is the bundle rather than the
 * inlining. `css-inline` is WASM whose wasm-bindgen glue assigns its own
 * `module.exports` to itself and then reads its `.wasm` through `__dirname`; inside
 * a bundle the first is a temporal-dead-zone error and the second looks in `dist/`.
 * Left external instead, it resolved from the application root in most kits and not
 * in the Vue kit, whose `workspaces` entry makes Bun install in the isolated layout
 * — so `app:build` produced a bundle that could not boot, and because the CLI hands
 * over to a newer bundle, `elvel.ts serve` stopped working too. Measured on a
 * scaffolded application from npm, not reasoned about.
 *
 * `juice` is ordinary JavaScript, so it bundles, and it matches whole CSS selectors
 * rather than the handful a hand-written inliner could be trusted with — a theme
 * that writes `.card p` is inlined rather than silently ignored.
 *
 * **Nothing is fetched**, and the type says so: `applyLinkTags` is not a member of
 * `juice()`'s options at all — following `<link>` tags belongs to `juiceResources`,
 * which this deliberately does not call. A mail is often rendered from content
 * somebody else supplied, and a renderer that followed links would fetch whatever
 * they point at from inside the network the worker runs in.
 *
 * `preserveMediaQueries` keeps the `@media` block, which is the one rule that cannot
 * become an attribute. It only carries width overrides, so a client that drops the
 * block loses nothing that makes the mail unreadable.
 */
export function inlineTheme(html: string, css: string = DEFAULT_THEME_CSS): string {
  return juice(html, {
    extraCss: css,
    preserveMediaQueries: true,
    removeStyleTags: true,
    applyStyleTags: true
  })
}
