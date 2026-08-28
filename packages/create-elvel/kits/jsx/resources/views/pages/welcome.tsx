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
                    <Button size="sm" href={nav.register}>
                      Get started
                    </Button>
                  ) : null}
                </>
              )}
            </nav>
          ) : null}
        </header>

        <main class="flex-1 py-16 sm:py-24">
          <h1 class="max-w-2xl text-4xl leading-tight font-semibold tracking-tight text-foreground sm:text-5xl">
            Laravel's shape,
            <br />
            <span class="text-brand italic">on Bun.</span>
          </h1>

          <p class="mt-6 max-w-xl text-muted-foreground">
            Service providers, a CLI, migrations and typed JSX views — over Elysia's HTTP server,
            with its type inference intact all the way into your handlers.
          </p>

          <div class="mt-14 grid gap-10 sm:grid-cols-2">
            <section>
              <h2 class="mb-4 text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Let's get started
              </h2>

              <ol class="space-y-3">
                {steps.map(([label, where], index) => (
                  <li class="border-l-2 pl-4">
                    <p
                      class={
                        index === 0
                          ? 'text-sm font-medium text-foreground'
                          : 'text-sm text-foreground'
                      }
                    >
                      {label}
                    </p>
                    <code class="font-mono text-xs text-muted-foreground">{where}</code>
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
                  <span class="text-brand">$</span> bun run elvel{'\n'}
                  <span class="text-brand">$</span> bun run elvel route:list{'\n'}
                  <span class="text-brand">$</span> bun run elvel make:controller Post -r{'\n'}
                  <span class="text-brand">$</span> bun run dev
                </pre>
              </div>

              <p class="mt-3 text-xs text-muted-foreground">
                A command exists only if its package is registered, so that first line is the honest
                list — not the framework's.
              </p>
            </section>
          </div>
        </main>

        <footer class="border-t py-6 text-xs text-muted-foreground">
          <a class="hover:text-brand" href="https://ufhy.github.io/elvel">
            ufhy.github.io/elvel
          </a>
        </footer>
      </div>
    </Layout>
  )
}
