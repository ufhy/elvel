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

        <Input name="email" type="email" label="Email" autocomplete="email" required />
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

      <div class="mt-5 space-y-2 text-center text-sm text-neutral-600 dark:text-neutral-400">
        <p>
          <a class="text-brand hover:underline" href="/forgot-password">
            Forgot your password?
          </a>
        </p>
        <p>
          No account yet?{' '}
          <a class="text-brand hover:underline" href="/sign-up">
            Create one
          </a>
        </p>
      </div>
    </AuthLayout>
  )
}
