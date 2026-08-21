import { classes } from '@elvel/view'

/** The three settings pages, with the current one marked. */
export function SettingsNav({ current }: { current: 'profile' | 'password' | 'security' }) {
  const pages = [
    ['profile', '/settings/profile', 'Profile'],
    ['password', '/settings/password', 'Password'],
    ['security', '/settings/security', 'Security']
  ] as const

  return (
    <nav class="mb-8 flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
      {pages.map(([key, href, label]) => (
        <a
          class={classes(
            '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
            key === current
              ? 'border-brand font-medium text-brand'
              : 'border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
          )}
          href={href}
          aria-current={key === current ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}
