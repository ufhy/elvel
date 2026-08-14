import { csrfField } from '@elysian/http'
import { Layout } from '../components/layout.tsx'

export type ResetPasswordProps = {
  title: string
  token: string
  error?: string | undefined
}

export function ResetPassword({ title, token, error }: ResetPasswordProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Choose a new password</h1>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        <form method="post" action="/reset-password" class="form">
          {csrfField()}

          {/* The token rides in the form, not the action, so it stays out of the
              browser history and out of any referrer sent to a third party. */}
          <input type="hidden" name="token" value={token} />

          <label>
            <span>New password</span>
            <input type="password" name="password" minlength="8" required autofocus />
          </label>

          <label>
            <span>Confirm it</span>
            <input type="password" name="password_confirmation" minlength="8" required />
          </label>

          <button type="submit">Set the password</button>
        </form>
      </section>
    </Layout>
  )
}
