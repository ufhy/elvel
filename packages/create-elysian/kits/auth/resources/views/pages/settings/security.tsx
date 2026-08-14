import { csrfField } from '@elysian/http'
import { Layout } from '../../components/layout.tsx'
import { SettingsNav } from './nav.tsx'

export type SessionRow = {
  id: string
  current: boolean
  createdAt?: string | undefined
  expiresAt?: string | undefined
  userAgent?: string | undefined
  ipAddress?: string | undefined
}

export type SecurityProps = {
  title: string
  sessions: SessionRow[]
  revoked?: boolean | undefined
  error?: string | undefined
}

export function Security({ title, sessions, revoked, error }: SecurityProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Security</h1>
        <SettingsNav current="security" />

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}
        {revoked ? <p class="notice">Signed out everywhere else.</p> : null}

        <p class="lede">
          Every browser currently signed in as you. Anything you do not recognise should go.
        </p>

        <ul class="sessions">
          {sessions.map((session) => (
            <li class={session.current ? 'session current' : 'session'}>
              <div>
                <strong safe>{session.userAgent ?? 'Unknown browser'}</strong>
                {session.current ? <span class="badge">this one</span> : null}
                <small class="muted" safe>
                  {[session.ipAddress, session.createdAt].filter(Boolean).join(' · ')}
                </small>
              </div>

              {session.current ? null : (
                <form method="post" action="/settings/security/revoke" class="inline">
                  {csrfField()}
                  <input type="hidden" name="id" value={session.id} />
                  <button type="submit" class="link">
                    Sign it out
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>

        <form method="post" action="/settings/security/revoke-others" class="form">
          {csrfField()}

          {/* The button that matters after a stolen laptop, and the reason this
              page exists at all. */}
          <button type="submit" class="destructive">
            Sign out every other session
          </button>
        </form>
      </section>
    </Layout>
  )
}
