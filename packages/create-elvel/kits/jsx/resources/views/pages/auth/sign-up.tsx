import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'

export type SignUpProps = {
  title: string
  error?: string | undefined
}

export function SignUp({ title }: SignUpProps) {
  return (
    <AuthLayout title={title} heading="Create an account" description="It takes a moment.">
      {/*
        No alert for `error` here.

        Every controller in this kit routes an auth failure to a *field* —
        `withErrors({ email: … })` — and `Input` reads that bag itself, so an
        alert carrying the same string said it twice: once at the top and once
        under the field it belongs to. The field is the better of the two, since
        it also highlights the input.
      */}

      <form class="space-y-4" method="post" action="/sign-up">
        {csrfField()}

        <Input name="name" label="Name" autocomplete="name" />
        <Input name="email" type="email" label="Email" autocomplete="email" />
        <Input name="password" type="password" label="Password" autocomplete="new-password" />

        <Button type="submit" class="w-full">
          Create account
        </Button>
      </form>

      <p class="mt-5 text-center text-sm text-muted-foreground">
        Already have one?{' '}
        <a
          class="underline decoration-border underline-offset-4 hover:decoration-current"
          href="/sign-in"
        >
          Sign in
        </a>
      </p>
    </AuthLayout>
  )
}
