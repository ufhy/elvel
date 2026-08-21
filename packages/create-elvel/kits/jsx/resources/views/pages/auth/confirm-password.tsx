import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'

export type ConfirmPasswordProps = {
  title: string
  error?: string | undefined
}

/**
 * Asked again before something dangerous, even though you are already signed in.
 *
 * A session open for hours is not proof the person at the keyboard is still the
 * owner — which is the whole point of the `password.confirm` middleware.
 */
export function ConfirmPassword({ title }: ConfirmPasswordProps) {
  return (
    <AuthLayout
      title={title}
      heading="Confirm your password"
      description="Please confirm your password before continuing."
    >
      {/*
        No alert for `error` here.

        Every controller in this kit routes an auth failure to a *field* —
        `withErrors({ email: … })` — and `Input` reads that bag itself, so an
        alert carrying the same string said it twice: once at the top and once
        under the field it belongs to. The field is the better of the two, since
        it also highlights the input.
      */}

      <form class="space-y-4" method="post" action="/confirm-password">
        {csrfField()}

        <Input
          name="password"
          type="password"
          label="Password"
          autocomplete="current-password"
          required
        />

        <Button type="submit" class="w-full">
          Confirm
        </Button>
      </form>
    </AuthLayout>
  )
}
