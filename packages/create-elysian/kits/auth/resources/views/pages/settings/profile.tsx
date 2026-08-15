import { csrfField, methodField, old } from '@elysian/http'
import { Layout } from '../../components/layout.tsx'
import { SettingsNav } from './nav.tsx'

export type ProfileProps = {
  title: string
  name: string
  email: string
  emailVerified: boolean
  saved?: boolean | undefined
  /** A new address was accepted and is waiting to be confirmed. */
  pending?: boolean | undefined
  error?: string | undefined
}

export function Profile({
  title,
  name,
  email,
  emailVerified,
  saved,
  pending,
  error
}: ProfileProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Profile</h1>
        <SettingsNav current="profile" />

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}
        {saved ? <p class="notice">Saved.</p> : null}
        {pending ? (
          /* The old address stays until the new one is confirmed, so saying
             "saved" here would be a lie the next sign-in would expose. */
          <p class="notice">
            Saved. Confirm the new address from the link we sent before it takes effect.
          </p>
        ) : null}

        {/* A browser form can only POST; `_method` is what reaches the PATCH
            route the framework registered. */}
        <form method="post" action="/settings/profile" class="form">
          {csrfField()}
          {methodField('PATCH')}

          <label>
            <span>Name</span>
            <input type="text" name="name" value={old('name') || name} required />
          </label>

          <label>
            <span>Email</span>
            <input type="email" name="email" value={old('email') || email} required />
            {emailVerified ? (
              <small class="muted">Confirmed.</small>
            ) : (
              /* Changing the address restarts verification, so say so before
                 somebody locks themselves out of a half-finished change. */
              <small class="muted">
                Not confirmed yet — <a href="/verify-email">send the link again</a>.
              </small>
            )}
          </label>

          <button type="submit">Save</button>
        </form>
      </section>

      <section class="panel danger">
        <h2>Delete this account</h2>
        <p class="lede">Everything goes, and none of it comes back.</p>

        <form method="post" action="/settings/profile" class="form">
          {csrfField()}
          {methodField('DELETE')}

          {/* Typing the password is the confirmation: a button alone is one
              mis-click away from a permanent loss. */}
          <label>
            <span>Password</span>
            <input type="password" name="password" required />
          </label>

          <button type="submit" class="destructive">
            Delete
          </button>
        </form>
      </section>
    </Layout>
  )
}
