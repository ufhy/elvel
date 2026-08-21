import { csrfField } from '@elvel/http'
import { classes } from '@elvel/view'
import { account, currentPath, initials, platformNav } from './app-sidebar.tsx'
import { Icon } from './ui/icon.tsx'

export type Crumb = { label: string; href?: string }

/**
 * Where you are, as a trail rather than a title.
 *
 * The last crumb is the current page and never a link — a link to the page you
 * are on is a small lie that screen readers repeat out loud.
 */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol class="flex items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1

          return (
            <li class="flex items-center gap-1.5">
              {index > 0 ? (
                <Icon name="chevron-right" class="size-3.5 text-muted-foreground" />
              ) : null}

              {crumb.href && !last ? (
                <a
                  class="text-muted-foreground transition-colors hover:text-foreground"
                  href={crumb.href}
                  safe
                >
                  {crumb.label}
                </a>
              ) : (
                <span class={classes(last ? 'font-medium' : 'text-muted-foreground')} safe>
                  {crumb.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * The header: a trail on the left, and — below `md`, where there is no sidebar —
 * the sidebar's links behind a menu button.
 */
export function AppHeader({ crumbs }: { crumbs: Crumb[] }) {
  const path = currentPath()
  const user = account()
  const platform = platformNav()

  return (
    <header class="flex h-16 shrink-0 items-center gap-2 border-b px-4 md:px-6">
      <details class="relative md:hidden">
        <summary
          class="flex size-9 cursor-pointer list-none items-center justify-center rounded-md hover:bg-accent"
          aria-label="Menu"
        >
          <Icon name="menu" class="size-5" />
        </summary>

        <div class="absolute top-full left-0 z-10 mt-1 w-64 rounded-md border bg-card p-1 shadow-md">
          {/* Who you are signed in as. The sidebar says this at every other
              width, and a menu that can sign you out should say whose session
              it is about to end. */}
          {user ? (
            <>
              <div class="flex items-center gap-2 p-2">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
                  <span safe>{initials(user.name)}</span>
                </span>
                <span class="grid min-w-0 leading-tight">
                  <span class="truncate text-sm font-medium" safe>
                    {user.name}
                  </span>
                  {user.email ? (
                    <span class="truncate text-xs text-muted-foreground" safe>
                      {user.email}
                    </span>
                  ) : null}
                </span>
              </div>

              <div class="my-1 h-px bg-border" role="presentation" />
            </>
          ) : null}

          {platform.map((item) => (
            <a
              class={classes(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                path === item.href
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground'
              )}
              href={item.href}
              aria-current={path === item.href ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              <span safe>{item.label}</span>
            </a>
          ))}

          <a
            class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            href="/settings/profile"
          >
            <Icon name="settings" />
            Settings
          </a>

          <div class="my-1 h-px bg-border" role="presentation" />

          <form action="/sign-out" method="post">
            {/* Without this the button is a 419 — see the note in the sidebar. */}
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

      {crumbs.length > 0 ? <Breadcrumbs crumbs={crumbs} /> : null}
    </header>
  )
}
