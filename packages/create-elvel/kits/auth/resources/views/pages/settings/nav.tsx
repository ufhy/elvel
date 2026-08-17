/** The three settings pages, with the current one marked. */
export function SettingsNav({ current }: { current: 'profile' | 'password' | 'security' }) {
  const pages = [
    ['profile', '/settings/profile', 'Profile'],
    ['password', '/settings/password', 'Password'],
    ['security', '/settings/security', 'Security']
  ] as const

  return (
    <nav class="tabs">
      {pages.map(([key, href, label]) => (
        <a
          href={href}
          class={key === current ? 'tab current' : 'tab'}
          aria-current={key === current ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}
