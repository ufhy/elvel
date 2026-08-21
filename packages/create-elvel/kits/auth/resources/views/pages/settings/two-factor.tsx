import { csrfField, methodField } from '@elvel/http'
import { renderSVG } from 'uqr'
import { Layout } from '../../components/layout.tsx'
import { SettingsNav } from './nav.tsx'

export type Enrolment = {
  /** The `otpauth://` URI. Empty when only new recovery codes were issued. */
  uri: string
  secret: string
  codes: string[]
}

export type TwoFactorProps = {
  title: string
  enabled: boolean
  pending?: Enrolment | undefined
  error?: string | undefined
}

/**
 * Turning two-factor on, and off again.
 *
 * Three states in one page, because they are three steps of one thing: off, being
 * set up, and on. Which one renders is decided by what the controller found —
 * `pending` is the enrolment it flashed, and it is the only time the secret and
 * the recovery codes are ever on screen.
 *
 * The QR code is rendered here, on the server, from the URI better-auth returned.
 * `uqr` draws it as SVG; there is no image to fetch and no third party involved,
 * which matters for a picture whose contents are a shared secret.
 */
export function TwoFactor({ title, enabled, pending, error }: TwoFactorProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Two-factor authentication</h1>
        <SettingsNav current="two-factor" />

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        {pending ? (
          <>
            {pending.uri ? (
              <>
                <h2>Scan this</h2>
                <p>
                  Point your authenticator app at the code, then enter the six digits it shows to
                  finish. Nothing is switched on until you do.
                </p>

                {/* `renderSVG` returns markup, which is what this needs to be. */}
                {renderSVG(pending.uri, { border: 1 })}

                <p>
                  Or type this key in by hand: <code safe>{pending.secret}</code>
                </p>

                <form method="post" action="/settings/two-factor/confirm" class="form">
                  {csrfField()}

                  <label>
                    <span>Code from the app</span>
                    <input
                      type="text"
                      name="code"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      required
                      autofocus
                    />
                  </label>

                  <button type="submit">Turn it on</button>
                </form>
              </>
            ) : null}

            <h2>Recovery codes</h2>
            <p>
              <strong>Save these now.</strong> Each one signs you in once if you lose your phone,
              and this is the only time they are shown.
            </p>

            <ul>
              {pending.codes.map((code) => (
                <li>
                  <code safe>{code}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {enabled && !pending ? (
          <>
            <p>Two-factor authentication is on for this account.</p>

            <h2>New recovery codes</h2>
            <p>Issuing new codes cancels the old ones.</p>

            <form method="post" action="/settings/two-factor/recovery-codes" class="form">
              {csrfField()}

              <label>
                <span>Confirm your password</span>
                <input type="password" name="password" autocomplete="current-password" required />
              </label>

              <button type="submit">Issue new codes</button>
            </form>

            <h2>Turn it off</h2>

            <form method="post" action="/settings/two-factor" class="form">
              {csrfField()}
              {methodField('DELETE')}

              <label>
                <span>Confirm your password</span>
                <input type="password" name="password" autocomplete="current-password" required />
              </label>

              <button type="submit">Turn off two-factor</button>
            </form>
          </>
        ) : null}

        {!enabled && !pending ? (
          <>
            <p>
              An authenticator app on your phone generates a code that changes every thirty seconds.
              With this on, your password alone is not enough to sign in.
            </p>

            <form method="post" action="/settings/two-factor" class="form">
              {csrfField()}

              <label>
                <span>Confirm your password</span>
                <input type="password" name="password" autocomplete="current-password" required />
              </label>

              <button type="submit">Set it up</button>
            </form>
          </>
        ) : null}
      </section>
    </Layout>
  )
}
