import { csrfField } from '@elyvel/http'
import { Layout } from '../../components/layout.tsx'

export type VerifyEmailProps = {
  title: string
  email: string
  sent?: boolean | undefined
  error?: string | undefined
}

export function VerifyEmail({ title, email, sent, error }: VerifyEmailProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Confirm your address</h1>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        {sent ? <p class="notice">A fresh link is on its way.</p> : null}

        <p class="lede">
          We sent a link to <strong safe>{email}</strong>. Open it and this page will let you
          through.
        </p>

        <form method="post" action="/verify-email/resend" class="form">
          {csrfField()}

          <button type="submit">Send it again</button>
        </form>

        <form method="post" action="/sign-out" class="form">
          {csrfField()}

          <button type="submit" class="link">
            Use a different account
          </button>
        </form>
      </section>
    </Layout>
  )
}
