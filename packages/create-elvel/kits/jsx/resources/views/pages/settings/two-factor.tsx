import { csrfField, methodField } from '@elvel/http'
import { renderSVG } from 'uqr'
import { Alert } from '../../components/ui/alert.tsx'
import { Button } from '../../components/ui/button.tsx'
import { CardHeader } from '../../components/ui/card.tsx'
import { Input } from '../../components/ui/input.tsx'
import { SettingsLayout } from './nav.tsx'

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
 * The recovery codes, which are shown exactly once.
 *
 * A grid of monospace rather than a paragraph: these get copied into a password
 * manager or written down, and both are easier when the codes line up.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div class="space-y-3">
      <Alert
        tone="info"
        message="Save these now — each one signs you in once, and this is the only time they are shown."
      />

      <ul class="grid grid-cols-2 gap-2 rounded-md bg-muted p-4 font-mono text-sm">
        {codes.map((code) => (
          <li safe>{code}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Turning two-factor on, and off again.
 *
 * Three states in one page, because they are three steps of one thing: off, being
 * set up, and on. Which one renders is decided by what the controller found —
 * `pending` is the enrolment it flashed, and the only moment the secret and the
 * recovery codes are ever on screen.
 *
 * The QR code is drawn here, on the server, from the URI better-auth returned.
 * `uqr` renders it as SVG: no image to fetch and no third party involved, which
 * is the right arrangement for a picture whose contents are a shared secret.
 */
export function TwoFactor({ title, enabled, pending, error }: TwoFactorProps) {
  return (
    <SettingsLayout title={title} current="two-factor">
      <div class="space-y-8">
        <div>
          <CardHeader
            title="Two-factor authentication"
            description="A code from your phone, on top of your password."
          />

          <Alert message={error} tone="error" />
        </div>

        {pending?.uri ? (
          <div class="space-y-4">
            <p class="text-sm text-muted-foreground">
              Scan this with your authenticator app, then enter the six digits it shows. Nothing is
              switched on until you do.
            </p>

            {/* `renderSVG` returns markup, which is what belongs here. */}
            <div class="inline-block rounded-md border bg-white p-3 [&_svg]:size-44">
              {renderSVG(pending.uri, { border: 1 })}
            </div>

            <p class="text-sm text-muted-foreground">
              Or type this key in by hand:{' '}
              <code class="font-mono text-foreground" safe>
                {pending.secret}
              </code>
            </p>

            <form class="max-w-xs space-y-4" method="post" action="/settings/two-factor/confirm">
              {csrfField()}

              <Input name="code" label="Code from the app" autocomplete="one-time-code" />

              <Button type="submit">Turn it on</Button>
            </form>
          </div>
        ) : null}

        {pending ? <RecoveryCodes codes={pending.codes} /> : null}

        {enabled && !pending ? (
          <div class="space-y-8">
            <Alert tone="success" message="Two-factor authentication is on for this account." />

            <form
              class="max-w-xs space-y-4"
              method="post"
              action="/settings/two-factor/recovery-codes"
            >
              {csrfField()}

              <CardHeader
                title="New recovery codes"
                description="Issuing new codes cancels the old ones."
              />

              <Input
                name="password"
                id="recovery-password"
                type="password"
                label="Confirm your password"
                autocomplete="current-password"
              />

              <Button variant="secondary" type="submit">
                Issue new codes
              </Button>
            </form>

            <form class="max-w-xs space-y-4" method="post" action="/settings/two-factor">
              {csrfField()}
              {methodField('DELETE')}

              <CardHeader
                title="Turn it off"
                description="Your password alone will be enough to sign in again."
              />

              <Input
                name="password"
                id="disable-password"
                type="password"
                label="Confirm your password"
                autocomplete="current-password"
              />

              <Button variant="danger" type="submit">
                Turn off two-factor
              </Button>
            </form>
          </div>
        ) : null}

        {!enabled && !pending ? (
          <form class="max-w-xs space-y-4" method="post" action="/settings/two-factor">
            {csrfField()}

            <p class="text-sm text-muted-foreground">
              An authenticator app generates a code that changes every thirty seconds. With this on,
              your password alone is not enough to sign in.
            </p>

            <Input
              name="password"
              type="password"
              label="Confirm your password"
              autocomplete="current-password"
            />

            <Button type="submit">Set it up</Button>
          </form>
        ) : null}
      </div>
    </SettingsLayout>
  )
}
