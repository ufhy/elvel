import { csrfField } from '@elvel/http'
import { AuthLayout } from '../../components/auth-layout.tsx'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'

export type VerifyEmailProps = {
  title: string
  email?: string | undefined
  sent?: boolean
  error?: string | undefined
}

export function VerifyEmail({ title, email, sent, error }: VerifyEmailProps) {
  return (
    <AuthLayout
      title={title}
      heading="Verify your email"
      description={email ? `We sent a link to ${email}.` : 'We sent you a link.'}
    >
      <Alert message={error} tone="error" class="mb-5" />
      <Alert message={sent ? 'A new link is on its way.' : undefined} tone="success" class="mb-5" />

      <div class="space-y-3">
        <form method="post" action="/verify-email/resend">
          {csrfField()}
          <Button type="submit" class="w-full">
            Send it again
          </Button>
        </form>

        <form method="post" action="/sign-out">
          {csrfField()}
          <Button variant="secondary" type="submit" class="w-full">
            Sign out
          </Button>
        </form>
      </div>
    </AuthLayout>
  )
}
