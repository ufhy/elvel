import type { Children } from '@kitajs/html'
import { entryTypes } from '../../entry-type.ts'
import type { WatcherStatus } from '../status.ts'

export type LayoutProps = {
  title: string
  /** Where the dashboard is mounted, with no slashes. */
  path: string
  /** The type whose tab is current, if a list or a detail is showing. */
  current?: string
  status?: WatcherStatus
  children?: Children
}

/**
 * The shell every Lens page renders inside.
 *
 * Telescope's layout is one blade file that inlines a built 1.6MB Vue bundle off
 * disk. This is the same idea with the bundle removed: pages are server-rendered
 * TSX, so there is nothing to build, nothing to publish, nothing committed to
 * the repository, and nothing to go stale against the version installed.
 *
 * The styles are inline for the reason the scaffolded `welcome.tsx` inlines
 * its own — a dashboard that needs `bun run build` before it looks like anything
 * is a dashboard nobody reaches for while debugging.
 */
export function Layout({ title, path, current, status, children }: LayoutProps) {
  return (
    <html lang="en" data-theme="auto">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>{title}</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <header class="bar">
          <a class="brand" href={`/${path}`}>
            Lens
          </a>
          {status === undefined ? null : <StatusPill status={status} />}
        </header>

        <div class="shell">
          <nav class="side">
            {entryTypes().map((type) => (
              <a class={type === current ? 'tab on' : 'tab'} href={`/${path}/${type}`}>
                {type}
              </a>
            ))}
          </nav>

          <main class="main">{children}</main>
        </div>
      </body>
    </html>
  )
}

/**
 * Why the list is empty, said out loud.
 *
 * Telescope's four states, and the point of them: a screen that cannot tell
 * "switched off" from "nothing happened yet" sends people to read config files.
 */
function StatusPill({ status }: { status: WatcherStatus }) {
  const label = {
    disabled: 'Lens is disabled',
    paused: 'recording paused',
    off: 'this watcher is off',
    enabled: 'recording'
  }[status]

  return (
    <span class={`pill ${status}`} safe>
      {label}
    </span>
  )
}

const STYLES = `
:root {
  --bg: #fbfbfa; --panel: #fff; --ink: #1d1c1a; --dim: #6b6862;
  --line: #e6e3dd; --accent: #7a5cff; --ok: #157f4a; --warn: #9a6700; --bad: #b42318;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16151a; --panel: #1d1c22; --ink: #edecea; --dim: #9a968e;
    --line: #2c2a33; --accent: #a08cff; --ok: #3dd68c; --warn: #e3b341; --bad: #ff7b72;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: inherit; text-decoration: none; }
.bar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
}
.brand { font-weight: 620; letter-spacing: -0.01em; }
.pill {
  margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim);
}
.pill.enabled { color: var(--ok); }
.pill.paused, .pill.off { color: var(--warn); }
.pill.disabled { color: var(--bad); }
.shell { display: flex; align-items: flex-start; }
.side {
  display: flex; flex-direction: column; padding: 14px 10px; gap: 1px;
  width: 160px; flex: 0 0 160px; position: sticky; top: 0;
}
.tab {
  padding: 6px 10px; border-radius: 7px; color: var(--dim); font-size: 13px;
}
.tab:hover { background: var(--panel); color: var(--ink); }
.tab.on { background: var(--panel); color: var(--ink); font-weight: 560; }
.main { flex: 1 1 auto; min-width: 0; padding: 18px 22px 60px; }
h1 { font-size: 17px; margin: 0 0 14px; font-weight: 620; }
h2 { font-size: 13px; margin: 22px 0 8px; color: var(--dim); font-weight: 560;
     text-transform: uppercase; letter-spacing: 0.06em; }
table { width: 100%; border-collapse: collapse; }
th, td {
  text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line);
  font-size: 13px; vertical-align: top;
}
th { color: var(--dim); font-weight: 560; font-size: 12px; }
tr:hover td { background: var(--panel); }
td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--dim); }
code, pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12.5px;
}
pre {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; overflow-x: auto; margin: 0 0 14px;
}
.wrap { overflow-x: auto; }
.tag {
  display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 5px;
  border: 1px solid var(--line); color: var(--dim); margin-right: 4px;
}
.method { font-weight: 620; font-size: 12px; }
.s2 { color: var(--ok); } .s3 { color: var(--dim); }
.s4 { color: var(--warn); } .s5 { color: var(--bad); }
.empty { color: var(--dim); padding: 28px 0; }
.back { color: var(--dim); font-size: 13px; display: inline-block; margin-bottom: 12px; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; margin: 0 0 16px; }
.kv dt { color: var(--dim); font-size: 12px; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
`
