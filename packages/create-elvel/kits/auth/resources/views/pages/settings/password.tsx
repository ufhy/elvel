import { csrfField, methodField } from '@elvel/http'
import { Layout } from '../../components/layout.tsx'
import { SettingsNav } from './nav.tsx'

export type PasswordProps = {
  title: string
  saved?: boolean | undefined
  error?: string | undefined
}

export function Password({ title, saved, error }: PasswordProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Password</h1>
        <SettingsNav current="password" />

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}
        {saved ? <p class="notice">Changed. Other sessions were signed out.</p> : null}

        <form method="post" action="/settings/password" class="form">
          {csrfField()}
          {methodField('PUT')}

          {/* The current one is required even though the session proves who this
              is: it is what stops a borrowed, unlocked browser becoming a
              permanent takeover. */}
          <label>
            <span>Current password</span>
            <input type="password" name="current" autofocus />
          </label>

          <label>
            <span>New password</span>
            <input type="password" name="password" minlength="8" />
          </label>

          <label>
            <span>Confirm it</span>
            <input type="password" name="password_confirmation" minlength="8" />
          </label>

          <button type="submit">Change it</button>
        </form>
      </section>
    </Layout>
  )
}
