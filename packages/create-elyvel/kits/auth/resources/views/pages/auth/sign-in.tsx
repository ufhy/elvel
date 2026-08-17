import { csrfField, old } from '@elyvel/http'
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
            <input type="email" name="email" value={old('email')} required autofocus />
          </label>

          <label>
            <span>Password</span>
            {/* Never refilled: a password in a session store is a password in a backup. */}
            <input type="password" name="password" required />
          </label>

          <button type="submit">Sign in</button>
        </form>

        <p class="muted">
          No account yet? <a href="/sign-up">Create one</a>.
        </p>
      </section>
    </Layout>
  )
}
