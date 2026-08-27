import { csrfField } from '@elvel/http'
import { Layout } from '../../components/layout.tsx'

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
 * `autocomplete="one-time-code"` is what lets a phone offer the code from the
 * message or the authenticator, and `inputmode="numeric"` gets the number pad.
 */
export function TwoFactorChallenge({ title, error }: TwoFactorChallengeProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Two-factor authentication</h1>
        <p>Enter the six-digit code from your authenticator app.</p>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        <form method="post" action="/two-factor-challenge" class="form">
          {csrfField()}

          <label>
            <span>Code</span>
            <input
              type="text"
              name="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              autofocus
            />
          </label>

          <button type="submit">Continue</button>
        </form>

        <hr />

        <h2>Lost your phone?</h2>
        <p>Use one of the recovery codes you saved when you turned this on.</p>

        <form method="post" action="/two-factor-challenge/recovery" class="form">
          {csrfField()}

          <label>
            <span>Recovery code</span>
            <input type="text" name="code" autocomplete="off" />
          </label>

          <button type="submit">Use a recovery code</button>
        </form>
      </section>
    </Layout>
  )
}
