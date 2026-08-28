import { config } from '@elvel/core'
import { Layout } from '../components/layout.tsx'
import { Button } from '../components/ui/button.tsx'
import { Mark } from '../components/ui/mark.tsx'

export type WelcomeProps = {
  title: string
  user?: { name: string } | null
  links?: {
    login?: string | undefined
    register?: string | undefined
    dashboard?: string | undefined
  }
}

const steps = [
  ['Edit the route that served this page', 'routes/web.ts'],
  ['Edit this page itself', 'resources/views/pages/welcome.tsx'],
  ['Decide what the application registers', 'bootstrap/providers.ts'],
  ['Then read the rest', 'ufhy.github.io/elvel']
] as const

export function Welcome({ title, user, links }: WelcomeProps) {
  const nav = links ?? {}
  const hasAuth = Boolean(nav.login || nav.register || nav.dashboard)

  return (
    <Layout title={title}>
      <div class="mx-auto flex min-h-dvh max-w-4xl flex-col px-6">
        <header class="flex items-center justify-between gap-4 border-b border-border py-6">
          <span class="flex items-center gap-2 text-brand">
            <Mark />
            <span class="text-xs font-semibold tracking-[0.22em] uppercase">Elvel</span>
          </span>

          {hasAuth ? (
            <nav class="flex items-center gap-2">
              {user ? (
                <>
                  <span class="hidden text-sm text-muted-foreground sm:block" safe>
                    {user.name}
                  </span>
                  {nav.dashboard ? (
                    <Button size="sm" href={nav.dashboard}>
                      Dashboard
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  {nav.login ? (
                    <Button variant="quiet" size="sm" href={nav.login}>
                      Log in
                    </Button>
                  ) : null}
                  {nav.register ? (
                    <Button variant="secondary" size="sm" href={nav.register}>
                      Register
                    </Button>
                  ) : null}
                </>
              )}
            </nav>
          ) : null}
        </header>

        <main class="flex-1 py-16 sm:py-24">
          <h1 class="max-w-2xl font-serif text-5xl leading-tight tracking-tight text-foreground sm:text-6xl">
            Laravel's shape,
            <br />
            <span class="text-brand italic">on Bun.</span>
          </h1>

          <p class="mt-6 max-w-xl font-serif text-lg leading-relaxed text-muted-foreground">
            Service providers, a CLI, migrations and typed JSX views — over Elysia's HTTP server,
            with its type inference intact all the way into your handlers.
          </p>

          <div class="mt-14 grid gap-10 sm:grid-cols-2">
            <section>
              <h2 class="mb-4 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Let's get started
              </h2>

              {/*
                A tick per step, joined by a hairline that stops at the last one —
                the same marker the other four kits draw in hand-written CSS. The
                spine is a bordered pseudo-element there; here it is a real element,
                because Tailwind has no `::before` and a `<span>` costs nothing.
              */}
              <ol class="space-y-0">
                {steps.map(([label, where], index) => (
                  <li class="relative flex gap-3.5 pb-6">
                    {index < steps.length - 1 ? (
                      <span class="absolute top-4 bottom-1 left-[0.28rem] border-l border-border" />
                    ) : null}

                    <span
                      class={
                        index === 0
                          ? 'mt-1.5 size-2.5 shrink-0 rounded-full border border-brand bg-brand'
                          : 'mt-1.5 size-2.5 shrink-0 rounded-full border border-border bg-background'
                      }
                    />

                    <div>
                      <p class="font-serif text-foreground">{label}</p>

                      {/* The last step points outward, so it is a link and not a path. */}
                      {where.includes('/') && !where.includes('.ts') ? (
                        <a
                          class="mt-1 block font-mono text-xs text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                          href={`https://${where}/`}
                        >
                          {where}
                        </a>
                      ) : (
                        <code class="mt-1 block font-mono text-xs text-muted-foreground">
                          {where}
                        </code>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h2 class="mb-4 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                From here
              </h2>

              <div class="rounded-xl border bg-muted p-4">
                <pre class="overflow-x-auto font-mono text-xs leading-6 text-foreground">
                  <span class="text-brand">$</span> bun run elvel{' '}
                  <span class="text-muted-foreground"># everything this app can do</span>
                  {'\n'}
                  <span class="text-brand">$</span> bun run elvel route:list{'\n'}
                  <span class="text-brand">$</span> bun run elvel make:controller Post -r{'\n'}
                  <span class="text-brand">$</span> bun run dev{' '}
                  <span class="text-muted-foreground"># the server and Vite, together</span>
                </pre>
              </div>

              <p class="mt-3 text-xs text-muted-foreground">
                A command exists only if its package is registered, so that first line is the honest
                list — not the framework's.
              </p>
            </section>
          </div>
        </main>

        {/*
          The application and its environment, as the other kits' layout renders it.
          It belongs to the page here rather than to the layout, because this kit's
          layout is shared with a dashboard that has a sidebar of its own.
        */}
        <footer class="flex items-center justify-center gap-2 py-8 font-mono text-xs text-muted-foreground">
          <span safe>{config<string>('app.name', 'Elvel')}</span>
          <span class="opacity-50">·</span>
          <span safe>{config<string>('app.env', 'production')}</span>
        </footer>
      </div>
    </Layout>
  )
}
