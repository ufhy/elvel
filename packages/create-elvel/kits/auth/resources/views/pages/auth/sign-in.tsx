import { csrfField, old } from '@elvel/http'
import { Layout } from '../../components/layout.tsx'

export type SignInProps = {
  title: string
  error?: string | undefined
}

export function SignIn({ title, error }: SignInProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Sign in</h1>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        <form method="post" action="/sign-in" class="form">
          {csrfField()}

          <label>
            <span>Email</span>
            {/* `webauthn` in the autocomplete turns on the browser's conditional
                UI: focus the field and a passkey for this site is offered from
                the same dropdown as a saved address. */}
            <input
              type="email"
              name="email"
              value={old('email')}
              autocomplete="username webauthn"
              autofocus
            />
          </label>

          <label>
            <span>Password</span>
            {/* Never refilled: a password in a session store is a password in a backup. */}
            <input type="password" name="password" />
          </label>

          <button type="submit">Sign in</button>
        </form>

        {/* A passkey, for the browsers that hold one. Not a form: there is
            nowhere to post to — the button asks the device to sign a challenge,
            and better-auth's own endpoint answers with the session. */}
        <div data-passkey-autofill>
          <button type="button" data-passkey="sign-in">
            Use a passkey
          </button>

          <p class="error" data-passkey-error hidden />
        </div>

        <p class="muted">
          No account yet? <a href="/sign-up">Create one</a>.
        </p>
      </section>
    </Layout>
  )
}
