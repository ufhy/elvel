import { config } from '@elvel/core'
import { routes } from '@elvel/http'
import type { Children } from '@kitajs/html'
import { Layout } from './layout.tsx'
import { Button } from './ui/button.tsx'
import { Mark } from './ui/mark.tsx'

/**
 * The shell every signed-in page shares: a sidebar, a header, and the page.
 *
 * The sidebar collapses to nothing under `md` and the links move into the header,
 * which is why there is no toggle and no JavaScript here. A drawer needs state,
 * state needs a client, and a server-rendered kit that reaches for one to show
 * five links has picked the wrong problem.
 */
export type AppShellProps = {
  title: string
  heading?: string
  user?: { name: string; email?: string } | null
  children?: Children
}

/**
 * The pages this shell links to.
 *
 * Literal paths, as the settings tabs underneath use — the settings routes are
 * not named, and naming them would mean editing the auth kit's controllers from
 * here. `dashboard` is named, so it is asked for; a sidebar pointing at a page
 * nobody scaffolded is worse than a short sidebar.
 */
const links = () => {
  const dashboard = routes().path('dashboard')

  return [
    ...(dashboard ? [{ label: 'Dashboard', href: dashboard }] : []),
    { label: 'Profile', href: '/settings/profile' },
    { label: 'Password', href: '/settings/password' },
    { label: 'Security', href: '/settings/security' }
  ]
}

export function AppShell({ title, heading, user, children }: AppShellProps) {
  const name = config<string>('app.name', 'Elvel')
  const nav = links()

  return (
    <Layout title={title}>
      <div class="flex min-h-dvh">
        <aside class="hidden w-60 shrink-0 border-r border-neutral-200 p-6 md:block dark:border-neutral-800">
          <a class="mb-8 flex items-center gap-2 text-brand" href="/">
            <Mark />
            <span class="text-xs font-semibold tracking-[0.22em] uppercase" safe>
              {name}
            </span>
          </a>

          <nav class="space-y-1">
            {nav.map((link) => (
              <a
                class="block rounded-lg px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                href={link.href}
                safe
              >
                {link.label}
              </a>
            ))}
          </nav>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
          <header class="flex items-center justify-between gap-4 border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
            {/* The same links, for the width where the sidebar is gone. */}
            <nav class="flex min-w-0 items-center gap-1 overflow-x-auto md:hidden">
              {nav.map((link) => (
                <a
                  class="rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                  href={link.href}
                  safe
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <span class="hidden text-sm text-neutral-500 md:block dark:text-neutral-400">
              {user ? <span safe>{user.name}</span> : null}
            </span>

            <form action="/sign-out" method="post">
              <Button variant="secondary" size="sm" type="submit">
                Sign out
              </Button>
            </form>
          </header>

          <main class="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
            {heading ? (
              <h1 class="mb-8 text-2xl font-semibold text-neutral-900 dark:text-neutral-50" safe>
                {heading}
              </h1>
            ) : null}

            {children}
          </main>
        </div>
      </div>
    </Layout>
  )
}
