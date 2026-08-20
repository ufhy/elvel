import { Layout } from '../components/layout.tsx'

export type WelcomeProps = {
  title: string
  /** Shown in the header when the application has somebody signed in. */
  user?: { name: string } | null
  /** Which auth routes exist, so the header offers only what is really there. */
  links?: { login?: string; register?: string; dashboard?: string }
}

/**
 * The page a new application answers with, and the first thing anybody sees.
 *
 * It carries its own styles rather than leaning on `resources/css/app.css`, for
 * the reason Laravel's `welcome.blade.php` inlines a stylesheet: before the first
 * `bun run build` there is no manifest, so `vite()` renders nothing and the page
 * would arrive as unstyled markup. A starter screen that looks broken until you
 * discover a build step is a poor first minute.
 *
 * Everything here is meant to be deleted. Nothing else imports it, the styles are
 * scoped under `.welcome`, and `app.css` is left as a blank page for your own.
 */
export function Welcome({ title, user, links }: WelcomeProps) {
  const nav = links ?? {}
  const hasAuth = Boolean(nav.login || nav.register || nav.dashboard)

  return (
    <Layout title={title}>
      <style>{styles}</style>

      <div class="welcome">
        <header class="rule">
          <span class="mark">Elvel</span>

          {hasAuth ? (
            <nav class="nav">
              {user ? (
                <>
                  <span class="who" safe>
                    {user.name}
                  </span>
                  {nav.dashboard ? (
                    <a class="button" href={nav.dashboard}>
                      Dashboard
                    </a>
                  ) : null}
                </>
              ) : (
                <>
                  {nav.login ? (
                    <a class="quiet" href={nav.login}>
                      Log in
                    </a>
                  ) : null}
                  {nav.register ? (
                    <a class="button" href={nav.register}>
                      Register
                    </a>
                  ) : null}
                </>
              )}
            </nav>
          ) : null}
        </header>

        <section class="lead">
          <h1>
            Laravel's shape,
            <br />
            <em>on Bun.</em>
          </h1>

          <p>
            Service providers, a CLI, migrations and typed JSX views — over Elysia's HTTP server,
            with its type inference intact all the way into your handlers.
          </p>
        </section>

        <section class="grid">
          <div class="col">
            <p class="label">Let's get started</p>

            <ol class="steps">
              <li>
                <span class="tick" />
                <div>
                  Edit the route that served this page
                  <code>app/Http/Controllers/PageController.ts</code>
                </div>
              </li>
              <li>
                <span class="tick" />
                <div>
                  Edit this page itself
                  <code>resources/views/pages/welcome.tsx</code>
                </div>
              </li>
              <li>
                <span class="tick" />
                <div>
                  Decide what the application registers
                  <code>bootstrap/providers.ts</code>
                </div>
              </li>
              <li>
                <span class="tick" />
                <div>
                  Then read the rest
                  <a href="https://github.com/ufhy/elvel">github.com/ufhy/elvel</a>
                </div>
              </li>
            </ol>
          </div>

          <div class="col">
            <p class="label">From here</p>

            <pre class="terminal">
              <span class="line">
                <span class="prompt">$</span> bun run elvel
                <span class="note"># everything this app can do</span>
              </span>
              <span class="line">
                <span class="prompt">$</span> bun run elvel route:list
              </span>
              <span class="line">
                <span class="prompt">$</span> bun run elvel make:controller Post -r
              </span>
              <span class="line">
                <span class="prompt">$</span> bun run dev:assets
                <span class="note"># styles, hot</span>
              </span>
            </pre>

            <p class="aside">
              A command exists only if its package is registered, so that first line is the honest
              list — not the framework's.
            </p>
          </div>
        </section>
      </div>
    </Layout>
  )
}

/**
 * Ink on paper, and a monospace spine.
 *
 * Set in faces that are already on the machine, so the first paint owes nothing
 * to a network — swap in a webfont from the layout when you want one. Dark mode
 * is the same relationships on warm near-black rather than a second palette.
 */
const styles = `
/*
 * The page-level basics, repeated here on purpose.
 *
 * \`app.css\` says the same things, but it arrives through \`vite()\` — which
 * renders nothing until the first build — so without these a new application
 * would serve this page on a white default body with the browser's own margin.
 * The values match, so once the build exists the two simply agree.
 */
body {
  margin: 0;
  background: #fbf9f5;
  -webkit-font-smoothing: antialiased;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem 1.5rem 3rem;
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #6f6a5d;
}

.footer .dot { opacity: 0.5; }

@media (prefers-color-scheme: dark) {
  body { background: #121110; }
  .footer { color: #9a9285; }
}

.welcome {
  --paper: #fbf9f5;
  --ink: #17150f;
  --faint: #6f6a5d;
  --line: #ddd7c9;
  --accent: #b8410f;
  --raise: #ffffff;

  font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;
  color: var(--ink);
  max-width: 62rem;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}

@media (prefers-color-scheme: dark) {
  .welcome {
    --paper: #121110;
    --ink: #ece7dc;
    --faint: #9a9285;
    --line: #2e2b26;
    --accent: #ff7a45;
    --raise: #1a1815;
  }
}

.welcome :where(code, pre, .mark, .label, .button, .quiet, .who) {
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

.welcome .rule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.9rem;
  border-bottom: 1px solid var(--line);
}

.welcome .mark {
  font-size: 0.78rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
}

.welcome .nav { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; }
.welcome .who { color: var(--faint); }

.welcome .quiet,
.welcome .button {
  text-decoration: none;
  color: var(--ink);
  padding: 0.32rem 0.8rem;
  border: 1px solid transparent;
  border-radius: 2px;
  transition: border-color 140ms ease, color 140ms ease;
}

.welcome .button { border-color: var(--line); }
.welcome .quiet:hover { color: var(--accent); }
.welcome .button:hover { border-color: var(--accent); color: var(--accent); }

.welcome .lead { padding: 4.5rem 0 3.5rem; }

.welcome h1 {
  margin: 0;
  font-size: clamp(2.6rem, 7vw, 4.6rem);
  font-weight: 400;
  line-height: 1.02;
  letter-spacing: -0.02em;
}

.welcome h1 em { font-style: italic; color: var(--accent); }

.welcome .lead p {
  margin: 1.6rem 0 0;
  max-width: 34rem;
  font-size: 1.07rem;
  line-height: 1.65;
  color: var(--faint);
}

.welcome .grid {
  display: grid;
  gap: 3rem;
  grid-template-columns: 1fr;
  padding-top: 2.5rem;
  border-top: 1px solid var(--line);
}

@media (min-width: 56rem) {
  .welcome .grid { grid-template-columns: 1fr 1fr; gap: 4rem; }
}

/*
 * A grid item will not shrink below its content unless told to.
 *
 * Without this the terminal block — whose lines are \`white-space: pre\` — holds
 * the column open, \`overflow-x\` never engages, and the whole page scrolls
 * sideways on a phone: 414px of it inside a 390px viewport.
 */
.welcome .col { min-width: 0; }

.welcome .label {
  margin: 0 0 1.4rem;
  font-size: 0.7rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--faint);
}

.welcome .steps { margin: 0; padding: 0; list-style: none; }

.welcome .steps li {
  position: relative;
  display: flex;
  gap: 0.9rem;
  padding: 0 0 1.5rem;
  font-size: 0.95rem;
  line-height: 1.5;
}

/* The spine: a hairline joining the ticks, stopping at the last one. */
.welcome .steps li:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 0.28rem;
  top: 1.1rem;
  bottom: 0.2rem;
  border-left: 1px solid var(--line);
}

.welcome .tick {
  flex: none;
  width: 0.6rem;
  height: 0.6rem;
  margin-top: 0.42rem;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--raise);
}

.welcome .steps li:first-child .tick { border-color: var(--accent); background: var(--accent); }

.welcome .steps code,
.welcome .steps a {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.82rem;
  color: var(--faint);
}

.welcome .steps a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--line); width: fit-content; }
.welcome .steps a:hover { border-color: var(--accent); }

.welcome .terminal {
  margin: 0;
  padding: 1.15rem 1.25rem;
  background: var(--raise);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 0.8rem;
  line-height: 1.9;
  overflow-x: auto;
}

.welcome .line { display: block; white-space: pre; }
.welcome .prompt { color: var(--accent); margin-right: 0.5rem; }
.welcome .note { color: var(--faint); margin-left: 0.6rem; }

.welcome .aside {
  margin: 1.1rem 0 0;
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--faint);
}

/* One reveal on load, staggered down the page. Nothing moves after that. */
.welcome > * { animation: rise 620ms cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }
.welcome .lead { animation-delay: 70ms; }
.welcome .grid { animation-delay: 140ms; }

@keyframes rise {
  from { opacity: 0; transform: translateY(0.6rem); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .welcome > * { animation: none; }
}
`
