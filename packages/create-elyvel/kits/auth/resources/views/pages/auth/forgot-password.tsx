import { csrfField, old } from '@elyvel/http'
import { Layout } from '../../components/layout.tsx'

export type ForgotPasswordProps = {
  title: string
  error?: string | undefined
  sent?: boolean | undefined
}

export function ForgotPassword({ title, error, sent }: ForgotPasswordProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Reset your password</h1>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        {sent ? (
          /**
           * The same answer whether the address exists or not.
           *
           * "No account with that email" turns this form into a way to ask
           * whether somebody has an account here, which is worth knowing to
           * anybody phishing them.
           */
          <p class="notice">
            If that address has an account, a link is on its way. Check the inbox.
          </p>
        ) : (
          <form method="post" action="/forgot-password" class="form">
            {csrfField()}

            <label>
              <span>Email</span>
              <input type="email" name="email" value={old('email')} required autofocus />
            </label>

            <button type="submit">Send the link</button>
          </form>
        )}

        <p class="muted">
          Remembered it? <a href="/sign-in">Sign in</a>.
        </p>
      </section>
    </Layout>
  )
}
