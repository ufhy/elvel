import { classes } from '@elvel/view'
import type { Children } from '@kitajs/html'
import { AppShell } from '../../components/app-shell.tsx'
import { Heading, Separator } from '../../components/ui/card.tsx'

export type SettingsPage =
  | 'profile'
  | 'password'
  | 'two-factor'
  | 'passkeys'
  | 'security'
  | 'appearance'

const pages = [
  ['profile', '/settings/profile', 'Profile'],
  ['password', '/settings/password', 'Password'],
  ['two-factor', '/settings/two-factor', 'Two-factor'],
  ['passkeys', '/settings/passkeys', 'Passkeys'],
  ['security', '/settings/security', 'Security'],
  ['appearance', '/settings/appearance', 'Appearance']
] as const

/**
 * The frame all four settings pages sit in.
 *
 * Still called `nav.tsx` — it was a row of tabs and is now a layout. The name
 * stays because this file *replaces* the auth kit's file at the same path; a
 * better-named copy would leave that one behind in every scaffolded application,
 * unused and slowly diverging.
 *
 * A layout rather than a bare nav, which is the shape Laravel's kits use: one
 * "Settings" heading for the whole area, the four pages listed down the left, and
 * a single `max-w-xl` column on the right. A page underneath then opens with its
 * own section heading instead of repeating where it is.
 */
export function SettingsLayout({
  title,
  current,
  children
}: {
  title: string
  current: SettingsPage
  children?: Children
}) {
  return (
    <AppShell title={title} crumbs={[{ label: 'Settings' }, { label: title }]}>
      <div class="px-4 py-6">
        <Heading title="Settings" description="Manage your profile and account settings" />

        <div class="flex flex-col lg:flex-row lg:space-x-12">
          <aside class="w-full max-w-xl lg:w-48">
            <nav class="flex flex-col space-y-1" aria-label="Settings">
              {pages.map(([key, href, label]) => (
                <a
                  class={classes(
                    'flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors',
                    key === current ? 'bg-muted' : 'hover:bg-accent hover:text-accent-foreground'
                  )}
                  href={href}
                  aria-current={key === current ? 'page' : undefined}
                >
                  {label}
                </a>
              ))}
            </nav>
          </aside>

          <Separator class="my-6 lg:hidden" />

          <div class="flex-1 md:max-w-2xl">
            <section class="max-w-xl space-y-12">{children}</section>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
