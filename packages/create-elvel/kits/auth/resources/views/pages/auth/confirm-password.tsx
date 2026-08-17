import { csrfField } from '@elvel/http'
import { Layout } from '../../components/layout.tsx'

export type ConfirmPasswordProps = {
  title: string
  error?: string | undefined
}

/**
 * The wall in front of the security settings — Laravel's `password.confirm`.
 *
 * Being signed in is not the same as being present. A session cookie survives a
 * borrowed laptop, a shared browser and a stolen phone; typing the password again
 * is the only thing on this page that proves somebody is actually there right now.
 * Once given, the answer counts for `auth.passwordTimeout` so that working through
 * several settings pages does not mean typing it five times.
 *
 * Where to go afterwards is not in this form: the middleware's `redirect().guest()`
 * already put the page they were heading for in the session, and `intended()` pulls
 * it back out once.
 */
export function ConfirmPassword({ title, error }: ConfirmPasswordProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Confirm your password</h1>
        <p>This is a secure area. Please confirm your password before continuing.</p>

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        <form method="post" action="/confirm-password" class="form">
          {csrfField()}

          <label>
            <span>Password</span>
            <input type="password" name="password" required autofocus />
          </label>

          <button type="submit">Confirm</button>
        </form>
      </section>
    </Layout>
  )
}
