import { csrfField, methodField } from '@elvel/http'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Card, CardHeader } from '../../components/ui/card.tsx'
import { Input } from '../../components/ui/input.tsx'
import { SettingsLayout } from './nav.tsx'

export type ProfileProps = {
  title: string
  name: string
  email: string
  emailVerified: boolean
  saved?: boolean | undefined
  /** A new address was accepted and is waiting to be confirmed. */
  pending?: boolean | undefined
  error?: string | undefined
}

export function Profile({ title, name, email, emailVerified, saved, pending }: ProfileProps) {
  return (
    <SettingsLayout title={title} current="profile">
      <div class="space-y-4">
        <Alert message={saved ? 'Saved.' : undefined} tone="success" />
        <Alert
          message={pending ? 'Check the old address to confirm the change.' : undefined}
          tone="info"
        />

        <Card>
          <CardHeader title="Profile" description="Your name and email address." />

          {/* A browser form can only POST; `_method` is what reaches the PATCH
              route the framework registered. */}
          <form class="space-y-4" method="post" action="/settings/profile">
            {csrfField()}
            {methodField('PATCH')}

            <Input name="name" label="Name" value={name} autocomplete="name" required />
            <Input
              name="email"
              type="email"
              label="Email"
              value={email}
              autocomplete="email"
              required
            />

            {emailVerified ? null : (
              <p class="text-sm text-muted-foreground">
                This address is not verified.{' '}
                <a
                  class="underline decoration-border underline-offset-4 hover:decoration-current"
                  href="/verify-email"
                >
                  Verify it
                </a>
              </p>
            )}

            <Button type="submit">Save</Button>
          </form>
        </Card>

        <Card class="border-destructive/30">
          <CardHeader
            title="Delete this account"
            description="Everything goes with it, and it cannot be undone."
          />

          <form class="space-y-4" method="post" action="/settings/profile">
            {csrfField()}
            {methodField('DELETE')}

            <Input
              name="password"
              type="password"
              label="Confirm your password"
              autocomplete="current-password"
              required
            />

            <Button variant="danger" type="submit">
              Delete this account
            </Button>
          </form>
        </Card>
      </div>
    </SettingsLayout>
  )
}
