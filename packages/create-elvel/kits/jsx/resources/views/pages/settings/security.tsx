import { csrfField } from '@elvel/http'
import { classes } from '@elvel/view'
import { AppShell } from '../../components/app-shell.tsx'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Card, CardHeader } from '../../components/ui/card.tsx'
import { SettingsNav } from './nav.tsx'

export type SessionRow = {
  id: string
  current: boolean
  createdAt?: string | undefined
  expiresAt?: string | undefined
  userAgent?: string | undefined
  ipAddress?: string | undefined
}

export type SecurityProps = {
  title: string
  sessions: SessionRow[]
  revoked?: boolean | undefined
  error?: string | undefined
}

export function Security({ title, sessions, revoked, error }: SecurityProps) {
  return (
    <AppShell title={title} heading="Settings">
      <SettingsNav current="security" />

      <div class="space-y-4">
        <Alert message={error} tone="error" />
        <Alert message={revoked ? 'Signed out everywhere else.' : undefined} tone="success" />

        <Card>
          <CardHeader
            title="Where you are signed in"
            description="Every browser currently signed in as you. Anything you do not recognise should go."
          />

          <ul class="divide-y divide-neutral-200 dark:divide-neutral-800">
            {sessions.map((session) => (
              <li
                class={classes(
                  'flex items-center justify-between gap-4 py-3',
                  session.current && 'rounded-lg bg-neutral-50 px-3 dark:bg-neutral-800/50'
                )}
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    <span safe>{session.userAgent ?? 'Unknown browser'}</span>
                    {session.current ? (
                      <span class="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                        this one
                      </span>
                    ) : null}
                  </p>
                  <p class="truncate text-xs text-neutral-500 dark:text-neutral-400" safe>
                    {[session.ipAddress, session.createdAt].filter(Boolean).join(' · ')}
                  </p>
                </div>

                {session.current ? null : (
                  <form method="post" action="/settings/security/revoke">
                    {csrfField()}
                    <input type="hidden" name="id" value={session.id} />
                    <Button variant="quiet" size="sm" type="submit">
                      Sign it out
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          <form class="mt-5" method="post" action="/settings/security/revoke-others">
            {csrfField()}
            <Button variant="secondary" type="submit">
              Sign out everywhere else
            </Button>
          </form>
        </Card>
      </div>
    </AppShell>
  )
}
