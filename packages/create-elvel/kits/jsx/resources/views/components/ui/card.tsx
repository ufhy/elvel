import { classes } from '@elvel/view'
import type { Children } from '@kitajs/html'

/**
 * A panel. The one shape the settings sections and the dashboard sit inside.
 *
 * `Children`, not `JSX.Element`.
 *
 * In `@kitajs/html` a `JSX.Element` is a `string` — the finished markup — while a
 * component that renders one is allowed to be async, so its type is
 * `string | Promise<string>`. Typing children as `JSX.Element` therefore rejects
 * every component passed into a card, which is most of what a card holds. It
 * failed `bun run typecheck` in sixteen places in a freshly scaffolded
 * application, and rendered perfectly the whole time, because `tsc` never sees
 * these files: the kits are excluded from the framework's own typecheck, and the
 * check that would have caught it only exists in an application.
 */
export function Card({ children, class: extra }: { children?: Children; class?: string }) {
  return (
    <div class={classes('rounded-xl border bg-card p-6 text-card-foreground shadow-sm', extra)}>
      {children}
    </div>
  )
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div class="mb-5 space-y-0.5">
      <h2 class="text-base leading-none font-medium" safe>
        {title}
      </h2>
      {description ? (
        <p class="text-sm text-muted-foreground" safe>
          {description}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A page's title and its one line of explanation.
 *
 * Laravel's kits call this `Heading`, and every settings page opens with one — so
 * the sizes and the gap are decided once here rather than per page.
 */
export function Heading({
  title,
  description,
  class: extra
}: {
  title: string
  description?: string
  class?: string
}) {
  return (
    <header class={classes('mb-8 space-y-0.5', extra)}>
      <h1 class="text-xl font-semibold tracking-tight" safe>
        {title}
      </h1>
      {description ? (
        <p class="text-sm text-muted-foreground" safe>
          {description}
        </p>
      ) : null}
    </header>
  )
}

/** A rule. `border-border` rather than a colour, so both themes get it right. */
export function Separator({ class: extra }: { class?: string }) {
  return <div class={classes('h-px w-full shrink-0 bg-border', extra)} role="presentation" />
}
