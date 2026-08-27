import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Separator } from '../../components/ui/card.tsx'
import { Input } from '../../components/ui/input.tsx'

export type TwoFactorChallengeProps = {
  title: string
  error?: string | undefined
}

/**
 * The code, between the password and the session.
 *
 * Two forms rather than one field that guesses which kind of code arrived: an
 * authenticator code and a recovery code go to different endpoints, and telling
 * them apart by shape is a rule that breaks the first time either format changes.
 *
 * No `<Alert>` for `error`: the controller puts the failure on the `code` field
 * and `Input` renders it there, under the box somebody has to retype.
 */
export function TwoFactorChallenge({ title }: TwoFactorChallengeProps) {
  return (
    <AuthLayout
      title={title}
      heading="Two-factor authentication"
      description="Enter the six-digit code from your authenticator app."
    >
      <form class="space-y-4" method="post" action="/two-factor-challenge">
        {csrfField()}

        {/* `one-time-code` is what lets a phone offer the code it just received,
            and `numeric` gets the number pad rather than the alphabet. */}
        <Input name="code" label="Code" autocomplete="one-time-code" />

        <Button type="submit" class="w-full">
          Continue
        </Button>
      </form>

      <Separator />

      <details class="group">
        <summary class="cursor-pointer list-none text-center text-sm text-muted-foreground hover:text-foreground">
          Lost your phone?
        </summary>

        <form class="mt-4 space-y-4" method="post" action="/two-factor-challenge/recovery">
          {csrfField()}

          {/* `code`, which is what the route reads — with its own id, since the
              form above already used the field name for one. */}
          <Input
            name="code"
            id="recovery-code"
            label="Recovery code"
            placeholder="One of the codes you saved"
            autocomplete="off"
          />

          <Button variant="secondary" type="submit" class="w-full">
            Use a recovery code
          </Button>
        </form>
      </details>
    </AuthLayout>
  )
}
