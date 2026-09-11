import { csrfToken } from '@elvel/http'
import type { Children } from '@kitajs/html'
import { labelFor, SECTIONS } from './ui.ts'

export type LayoutProps = {
  title: string
  /** Where the dashboard is mounted, with no slashes. */
  path: string
  /** The entry type whose tab is current, or `monitoring`. */
  current?: string
  /** Whether recording is paused, for the header's toggle. */
  paused?: boolean
  children?: Children
}

/**
 * The shell every Lens page renders inside.
 *
 * Modelled on Telescope's `layout.blade.php` rather than invented: a centred
 * container, a header carrying the name and the actions that change state, and
 * a two-column body with a grouped sidebar. The first version of this file was
 * a bare table with a list of lowercase type names down the side, which is what
 * you get from reading a package's PHP and never opening its dashboard.
 *
 * What is deliberately not copied is the machinery. Telescope's header buttons
 * are Vue click handlers against its API; these are forms, because the page is
 * server-rendered and a form is what works without shipping a bundle.
 */
export function Layout({ title, path, current, paused, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>{title}</title>
        {/*
         * Inline, the way Telescope's layout carries a base64 one.
         *
         * Not decoration: without it every dashboard page load asks for
         * `/favicon.ico`, misses, and the recorder files a 404 of its own
         * making — noise in the very list somebody came to read.
         */}
        <link rel="icon" href={FAVICON} />
        <style>{STYLES}</style>
      </head>
      <body>
        <div class="container">
          <header class="head">
            <a class="logo" href={`/${path}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M11 3a8 8 0 1 0 4.9 14.32l4.39 4.39 1.42-1.42-4.39-4.39A8 8 0 0 0 11 3Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z" />
              </svg>
              <h1>
                <strong>Elvel</strong> Lens
              </h1>
            </a>

            <div class="actions">
              <form method="post" action={`/${path}/${paused === true ? 'resume' : 'pause'}`}>
                <input type="hidden" name="_token" value={csrfToken()} safe />
                <button
                  type="submit"
                  title={paused === true ? 'Resume recording' : 'Pause recording'}
                >
                  {paused === true ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
                    </svg>
                  )}
                </button>
              </form>

              <form
                method="post"
                action={`/${path}/clear`}
                onsubmit="return confirm('Delete every recorded entry?')"
              >
                <input type="hidden" name="_token" value={csrfToken()} safe />
                <button type="submit" title="Clear entries">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 12H7L6 9Z" />
                  </svg>
                </button>
              </form>

              <a
                class={current === 'monitoring' ? 'button on' : 'button'}
                href={`/${path}/monitoring`}
                title="Monitoring"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                </svg>
              </a>
            </div>
          </header>

          <div class="body">
            <nav class="sidebar">
              {SECTIONS.map((section, index) => (
                <ul class={index === 0 ? 'group' : 'group spaced'}>
                  {section.types.map((type) => (
                    <li>
                      <a class={type === current ? 'nav on' : 'nav'} href={`/${path}/${type}`} safe>
                        {labelFor(type)}
                      </a>
                    </li>
                  ))}
                </ul>
              ))}
            </nav>

            <main class="main">{children}</main>
          </div>
        </div>
      </body>
    </html>
  )
}

/**
 * Telescope's palette, from `_colors.scss`, as tokens.
 *
 * Light and dark both, because the viewer's system decides and a debugging tool
 * that is blinding at two in the morning is a tool nobody opens then.
 */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%236366f1' d='M11 3a8 8 0 1 0 4.9 14.32l4.39 4.39 1.42-1.42-4.39-4.39A8 8 0 0 0 11 3Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z'/%3E%3C/svg%3E"

const STYLES = `
:root {
  --bg: #f3f4f6; --card: #ffffff; --cap: #f9fafb; --line: #e5e7eb;
  --ink: #111827; --dim: #6b7280; --faint: #9ca3af;
  --brand: #6366f1;
  --success-fg: #047857; --success-bg: #d1fae5;
  --info-fg: #1d4ed8;    --info-bg: #dbeafe;
  --warning-fg: #b45309; --warning-bg: #fef3c7;
  --danger-fg: #b91c1c;  --danger-bg: #fee2e2;
  --secondary-fg: #4b5563; --secondary-bg: #e5e7eb;
  --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827; --card: #1f2937; --cap: #263244; --line: #374151;
    --ink: #f3f4f6; --dim: #9ca3af; --faint: #6b7280;
    --brand: #818cf8;
    --success-fg: #6ee7b7; --success-bg: #064e3b;
    --info-fg: #93c5fd;    --info-bg: #1e3a8a;
    --warning-fg: #fcd34d; --warning-bg: #78350f;
    --danger-fg: #fca5a5;  --danger-bg: #7f1d1d;
    --secondary-fg: #d1d5db; --secondary-bg: #374151;
    --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding-bottom: 40px; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: inherit; text-decoration: none; }
svg { width: 1rem; height: 1rem; fill: currentColor; }
.container { max-width: 1440px; margin: 0 auto; padding: 0 20px; }
.head {
  display: flex; align-items: center; gap: 12px;
  padding: 22px 0; border-bottom: 1px solid var(--line);
}
.logo { display: flex; align-items: center; gap: 12px; color: var(--brand); }
.logo svg { width: 1.7rem; height: 1.7rem; }
.logo h1 { font-size: 1.15rem; font-weight: 400; margin: 0; color: var(--ink); }
.logo strong { font-weight: 700; }
.actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.actions form { margin: 0; display: flex; }
.actions button, .actions .button {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 32px; padding: 0; cursor: pointer;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--card); color: var(--dim);
}
.actions button:hover, .actions .button:hover { color: var(--brand); border-color: var(--brand); }
.actions .button.on { color: var(--brand); border-color: var(--brand); }
.body { display: flex; gap: 24px; align-items: flex-start; padding-top: 26px; }
.sidebar { flex: 0 0 200px; width: 200px; position: sticky; top: 20px; }
.group { list-style: none; margin: 0; padding: 0; }
.group.spaced { margin-top: 18px; }
.nav {
  display: block; padding: 0.5rem 0.75rem; margin-bottom: 4px;
  border-radius: 8px; color: var(--dim);
}
.nav:hover { background: var(--card); color: var(--ink); }
.nav.on { background: var(--card); color: var(--brand); font-weight: 600; box-shadow: var(--shadow); }
.main { flex: 1 1 auto; min-width: 0; }
.card {
  background: var(--card); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
  margin-bottom: 22px;
}
.card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  min-height: 60px; padding: 0.7rem 1.25rem; background: var(--cap);
}
.card-head h2 { font-size: 0.9rem; font-weight: 600; margin: 0; }
.card-body { padding: 1.25rem; }
.banner {
  display: flex; align-items: center; gap: 8px; margin: 0;
  padding: 0.6rem 1.25rem; background: var(--warning-bg); color: var(--warning-fg);
  font-size: 13px;
}
.blank {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 56px 20px; color: var(--faint); background: var(--cap);
}
.blank svg { width: 2rem; height: 2rem; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.7rem 1.25rem; border-top: 1px solid var(--line); text-align: left; }
thead th { border-top: 0; color: var(--dim); font-size: 12px; font-weight: 600; }
tbody tr:hover { background: var(--cap); }
td.fit { width: 1%; white-space: nowrap; }
td.right, th.right { text-align: right; }
td.center, th.center { text-align: center; }
td.muted { color: var(--dim); }
.badge {
  display: inline-block; padding: 0.25em 0.55em; border-radius: 6px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
  background: var(--secondary-bg); color: var(--secondary-fg);
}
.badge.success { background: var(--success-bg); color: var(--success-fg); }
.badge.info { background: var(--info-bg); color: var(--info-fg); }
.badge.warning { background: var(--warning-bg); color: var(--warning-fg); }
.badge.danger { background: var(--danger-bg); color: var(--danger-fg); }
.search { position: relative; display: flex; align-items: center; width: 260px; }
.search svg {
  position: absolute; left: 0.75rem; pointer-events: none; color: var(--faint);
}
.search input {
  width: 100%; padding: 0.4rem 0.9rem 0.4rem 2.25rem;
  font: inherit; font-size: 0.875rem; color: var(--ink);
  background: var(--card); border: 1px solid var(--line); border-radius: 9999px;
  appearance: none;
}
.search input::placeholder { color: var(--faint); }
.search input:focus { outline: none; border-color: var(--brand); }
.search input::-webkit-search-cancel-button { cursor: pointer; }
.field {
  padding: 0.4rem 0.9rem; font: inherit; font-size: 0.875rem; color: var(--ink);
  background: var(--card); border: 1px solid var(--line); border-radius: 8px;
}
.field:focus { outline: none; border-color: var(--brand); }
.btn {
  padding: 0.4rem 0.9rem; font: inherit; font-size: 0.875rem; cursor: pointer;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--line); border-radius: 8px;
}
.btn:hover { border-color: var(--brand); color: var(--brand); }
.btn.quiet { border: 0; background: none; color: var(--dim); padding: 0; }
.btn.quiet:hover { color: var(--danger-fg); }
.row { display: flex; gap: 10px; align-items: center; }
.hint { color: var(--dim); margin: 0 0 16px; font-size: 13px; }
.more { text-align: center; background: var(--cap); }
.more a { color: var(--brand); font-size: 13px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
pre {
  background: var(--cap); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px; overflow-x: auto; margin: 0;
}
.wrap { overflow-x: auto; }
.kv { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
.kv dt { color: var(--dim); font-size: 12px; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.tag {
  display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 6px;
  background: var(--secondary-bg); color: var(--secondary-fg); margin: 0 4px 4px 0;
}
.back { color: var(--dim); font-size: 13px; display: inline-block; margin-bottom: 14px; }
.back:hover { color: var(--brand); }
`
