import { user } from '@elvel/auth'
import { config } from '@elvel/core'
import { csrfField, currentScope, routes } from '@elvel/http'
import { classes } from '@elvel/view'
import { Icon, type IconName } from './ui/icon.tsx'
import { Mark } from './ui/mark.tsx'

export type NavItem = { label: string; href: string; icon: IconName }

export type Account = { name: string; email?: string } | null

/**
 * Who is signed in, read from the request rather than passed down.
 *
 * `user()` works anywhere inside a request, which is the same reason `errors()`
 * and `old()` do — so the shell asks for the account itself and no page has to
 * remember to hand it over. Two pages here had already forgotten to.
 *
 * The narrowing is real work, not ceremony: an `AuthUser` is `{ id }` plus
 * whatever the model carries, so `name` is `unknown` until something checks.
 */
export function account(): Account {
  const current = user()

  if (!current) return null

  const name = typeof current.name === 'string' && current.name.trim() ? current.name : 'Account'
  const email = typeof current.email === 'string' ? current.email : undefined

  return { name, email }
}

/**
 * The path being rendered, so a link can say it is the current one.
 *
 * Read from the request scope rather than passed down. Laravel's React kit calls
 * a `useCurrentUrl()` hook for this and reaches the same conclusion from the
 * other direction: whether a link is active is a fact about the request, and
 * threading it through every page to reach the sidebar is plumbing that only
 * exists to be forgotten by the next page somebody adds.
 */
export function currentPath(): string {
  const request = currentScope()?.request

  return request ? new URL(request.url).pathname : '/'
}

/**
 * The pages this shell links to.
 *
 * `dashboard` is asked for by name — a sidebar pointing at a page nobody
 * scaffolded is worse than a short sidebar. The settings routes are literal
 * paths, as the settings nav underneath uses: they are not named, and naming
 * them would mean editing the auth kit's controllers from here.
 */
export function platformNav(): NavItem[] {
  const dashboard = routes().path('dashboard')

  return dashboard ? [{ label: 'Dashboard', href: dashboard, icon: 'layout-grid' }] : []
}

const footerNav: NavItem[] = [
  { label: 'Repository', href: 'https://github.com/ufhy/elvel', icon: 'folder-git-2' },
  { label: 'Documentation', href: 'https://ufhy.github.io/elvel', icon: 'book-open-text' }
]

/** Two letters for the avatar, the way every account menu does it. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)

  if (parts.length === 0) return '?'

  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''

  return (first + last).toUpperCase()
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      class={classes(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
      href={item.href}
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={item.icon} />
      <span safe>{item.label}</span>
    </a>
  )
}

/** The account menu, which is a `<details>` because a dropdown is disclosure. */
export function AccountMenu({ user, class: extra }: { user: Account; class?: string }) {
  if (!user) return ''

  return (
    <details class={classes('group relative', extra)}>
      <summary class="flex cursor-pointer list-none items-center gap-2 rounded-md p-2 hover:bg-sidebar-accent">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
          <span safe>{initials(user.name)}</span>
        </span>
        <span class="grid min-w-0 flex-1 text-left leading-tight">
          <span class="truncate text-sm font-medium" safe>
            {user.name}
          </span>
          {user.email ? (
            <span class="truncate text-xs text-muted-foreground" safe>
              {user.email}
            </span>
          ) : null}
        </span>
        <Icon name="chevrons-up-down" class="ml-auto" />
      </summary>

      {/*
        Above the summary, not below it: this menu sits at the bottom of the
        sidebar, and a panel opening downwards there opens off the page.
      */}
      <div class="absolute bottom-full left-0 z-10 mb-1 w-full min-w-56 rounded-md border bg-card p-1 shadow-md">
        <a
          class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          href="/settings/profile"
        >
          <Icon name="settings" />
          Settings
        </a>

        <div class="my-1 h-px bg-border" role="presentation" />

        {/* A POST, because signing out changes state — a link would let any page
            with an `<img>` sign you out. */}
        <form action="/sign-out" method="post">
          {/*
            The token, without which this button is a 419.
            The kit shipped this form without it, and it looked entirely correct —
            the menu opened, the button submitted, and the middleware rejected it.
            Nothing rendered wrong, so nothing looked wrong.
          */}
          {csrfField()}

          <button
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            type="submit"
          >
            <Icon name="log-out" />
            Sign out
          </button>
        </form>
      </div>
    </details>
  )
}

/**
 * The sidebar, and the shape most of this kit's look comes from.
 *
 * Fixed at `md` and up, and simply absent below it — the header carries the same
 * links there. Laravel's kit slides a sheet in instead, which needs a component
 * library, an overlay, focus trapping and a client to run it; the links are the
 * point, and they fit in a menu.
 */
export function AppSidebar() {
  const name = config<string>('app.name', 'Elvel')
  const signedIn = account()
  const path = currentPath()
  const platform = platformNav()

  return (
    <aside class="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div class="p-2">
        <a
          class="flex items-center gap-2 rounded-md p-2 hover:bg-sidebar-accent"
          href="/"
          aria-label={name}
        >
          <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Mark />
          </span>
          <span class="truncate text-sm leading-tight font-semibold" safe>
            {name}
          </span>
        </a>
      </div>

      <nav class="flex-1 p-2" aria-label="Platform">
        <p class="px-2 py-1.5 text-xs text-muted-foreground">Platform</p>

        <div class="space-y-1">
          {platform.map((item) => (
            <NavLink item={item} active={path === item.href} />
          ))}
        </div>
      </nav>

      <div class="p-2">
        <div class="mb-1 space-y-1">
          {footerNav.map((item) => (
            <NavLink item={item} active={false} />
          ))}
        </div>

        <AccountMenu user={signedIn} />
      </div>
    </aside>
  )
}
