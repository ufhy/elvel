import { classes } from '@elvel/view'

/** A panel. The one shape every auth and settings page here sits inside. */
export function Card({ children, class: extra }: { children?: JSX.Element; class?: string }) {
  return (
    <div
      class={classes(
        'rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm',
        'dark:border-neutral-800 dark:bg-neutral-900',
        extra
      )}
    >
      {children}
    </div>
  )
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div class="mb-5 space-y-1">
      <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50" safe>
        {title}
      </h2>
      {description ? (
        <p class="text-sm text-neutral-600 dark:text-neutral-400" safe>
          {description}
        </p>
      ) : null}
    </div>
  )
}
