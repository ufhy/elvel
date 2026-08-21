import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'

export type ResetPasswordProps = {
  title: string
  token: string
  error?: string | undefined
}

export function ResetPassword({ title, token }: ResetPasswordProps) {
  return (
    <AuthLayout title={title} heading="Set a new password">
      {/*
        No alert for `error` here.

        Every controller in this kit routes an auth failure to a *field* —
        `withErrors({ email: … })` — and `Input` reads that bag itself, so an
        alert carrying the same string said it twice: once at the top and once
        under the field it belongs to. The field is the better of the two, since
        it also highlights the input.
      */}

      <form class="space-y-4" method="post" action="/reset-password">
        {csrfField()}
        <input type="hidden" name="token" value={token} />

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
          label="Confirm password"
          autocomplete="new-password"
          required
        />

        <Button type="submit" class="w-full">
          Save it
        </Button>
      </form>
    </AuthLayout>
  )
}
