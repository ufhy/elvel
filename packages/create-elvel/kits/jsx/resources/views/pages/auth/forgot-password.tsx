import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'

export type ForgotPasswordProps = {
  title: string
  error?: string | undefined
  sent?: boolean
}

export function ForgotPassword({ title, sent }: ForgotPasswordProps) {
  return (
    <AuthLayout
      title={title}
      heading="Forgot your password?"
      description="We will email you a link to set a new one."
    >
      {/*
        No alert for `error`: the controller routes it to a field, and `Input`
        reads that bag itself — see the note in sign-in.
      */}
      <Alert
        message={sent ? 'Check your inbox for the link.' : undefined}
        tone="success"
        class="mb-5"
      />

      <form class="space-y-4" method="post" action="/forgot-password">
        {csrfField()}

        <Input name="email" type="email" label="Email" autocomplete="email" />

        <Button type="submit" class="w-full">
          Email the link
        </Button>
      </form>

      <p class="mt-5 text-center text-sm text-muted-foreground">
        <a
          class="underline decoration-border underline-offset-4 hover:decoration-current"
          href="/sign-in"
        >
          Back to sign in
        </a>
      </p>
    </AuthLayout>
  )
}
