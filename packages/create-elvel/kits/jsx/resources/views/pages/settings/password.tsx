import { csrfField, methodField } from '@elvel/http'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Card, CardHeader } from '../../components/ui/card.tsx'
import { Input } from '../../components/ui/input.tsx'
import { SettingsLayout } from './nav.tsx'

export type PasswordProps = {
  title: string
  saved?: boolean | undefined
  error?: string | undefined
}

export function Password({ title, saved }: PasswordProps) {
  return (
    <SettingsLayout title={title} current="password">
      <div class="space-y-4">
        <Alert message={saved ? 'Your password was changed.' : undefined} tone="success" />

        <Card>
          <CardHeader
            title="Password"
            description="Long is better than complicated. Every session but this one is signed out."
          />

          <form class="space-y-4" method="post" action="/settings/password">
            {csrfField()}
            {methodField('PUT')}

            <Input
              name="current"
              type="password"
              label="Current password"
              autocomplete="current-password"
              required
            />
            <Input
              name="password"
              type="password"
              label="New password"
              autocomplete="new-password"
              required
            />
            <Input
              name="password_confirmation"
              type="password"
              label="Confirm new password"
              autocomplete="new-password"
              required
            />

            <Button type="submit">Change it</Button>
          </form>
        </Card>
      </div>
    </SettingsLayout>
  )
}
