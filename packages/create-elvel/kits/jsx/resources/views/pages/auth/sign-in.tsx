import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'

export type SignInProps = {
  title: string
  error?: string | undefined
}

export function SignIn({ title }: SignInProps) {
  return (
    <AuthLayout title={title} heading="Sign in" description="Welcome back.">
      {/*
        No alert for `error` here.

        Every controller in this kit routes an auth failure to a *field* —
        `withErrors({ email: … })` — and `Input` reads that bag itself, so an
        alert carrying the same string said it twice: once at the top and once
        under the field it belongs to. The field is the better of the two, since
        it also highlights the input.
      */}

      <form class="space-y-4" method="post" action="/sign-in">
        {csrfField()}

        {/*
          `webauthn` in the autocomplete, which is what turns on the browser's
          conditional UI: focus the field and any passkey for this site is offered
          from the same dropdown as a saved address. `resources/js/passkeys.ts`
          only starts that flow when `data-passkey-autofill` is on the page.
        */}
        <Input name="email" type="email" label="Email" autocomplete="username webauthn" required />
        {/* Never refilled: a password in a session store is a password in a backup. */}
        <Input
          name="password"
          type="password"
          label="Password"
          autocomplete="current-password"
          required
        />

        <Button type="submit" class="w-full">
          Sign in
        </Button>
      </form>

      {/*
        A passkey, for the browsers that hold one.
        Not a form — there is nowhere to post to. The button asks the device to
        sign a challenge, and better-auth's own endpoint answers with the session.
      */}
      <div class="space-y-3" data-passkey-autofill>
        <div class="flex items-center gap-3">
          <span class="h-px flex-1 bg-border" role="presentation" />
          <span class="text-xs text-muted-foreground">or</span>
          <span class="h-px flex-1 bg-border" role="presentation" />
        </div>

        <Button variant="secondary" type="button" class="w-full" data={{ passkey: 'sign-in' }}>
          Use a passkey
        </Button>

        <p
          class="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          data-passkey-error
          hidden
          role="alert"
        />
      </div>

      <div class="mt-5 space-y-2 text-center text-sm text-muted-foreground">
        <p>
          <a
            class="underline decoration-border underline-offset-4 hover:decoration-current"
            href="/forgot-password"
          >
            Forgot your password?
          </a>
        </p>
        <p>
          No account yet?{' '}
          <a
            class="underline decoration-border underline-offset-4 hover:decoration-current"
            href="/sign-up"
          >
            Create one
          </a>
        </p>
      </div>
    </AuthLayout>
  )
}
