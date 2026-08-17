import { csrfField, old } from '@elvel/http'
import { Layout } from '../../components/layout.tsx'

export type SignUpProps = {
  title: string
  error?: string | undefined
}

export function SignUp({ title, error }: SignUpProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Create an account</h1>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        <form method="post" action="/sign-up" class="form">
          {csrfField()}

          <label>
            <span>Name</span>
            <input type="text" name="name" value={old('name')} required autofocus />
          </label>

          <label>
            <span>Email</span>
            <input type="email" name="email" value={old('email')} required />
          </label>

          <label>
            <span>Password</span>
            <input type="password" name="password" minlength="8" required />
          </label>

          <button type="submit">Create account</button>
        </form>

        <p class="muted">
          Already registered? <a href="/sign-in">Sign in</a>.
        </p>
      </section>
    </Layout>
  )
}
