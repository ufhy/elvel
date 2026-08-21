import { csrfField, methodField } from '@elvel/http'
import type { PasskeyRow } from '../../../../app/Http/Controllers/Settings/PasskeyController.ts'
import { Layout } from '../../components/layout.tsx'
import { SettingsNav } from './nav.tsx'

export type PasskeysProps = {
  title: string
  passkeys: PasskeyRow[]
  removed?: boolean | undefined
  error?: string | undefined
}

/**
 * The keys this account can be opened with.
 *
 * One button here is not a form: registering a passkey has to ask the *device* to
 * create a key, which only script on the page can do — `data-passkey="register"`
 * is what `resources/js/passkeys.ts` listens for. Everything else on the page is
 * ordinary HTML, including removal, so the list still works with JavaScript off.
 */
export function Passkeys({ title, passkeys, removed, error }: PasskeysProps) {
  return (
    <Layout title={title}>
      <section class="panel">
        <h1>Passkeys</h1>
        <SettingsNav current="passkeys" />

        {removed ? <p>That passkey was removed.</p> : null}

        {error ? (
          <p class="error" safe>
            {error}
          </p>
        ) : null}

        {/* Filled in by the script when the device refuses or the prompt is
            dismissed; hidden until then, since there is nothing to say. */}
        <p class="error" data-passkey-error hidden />

        <h2>Add one</h2>
        <p>
          Your device makes a key it will not hand over — a fingerprint, a face, or the screen lock
          — and this site only ever sees the signature.
        </p>

        <div class="form">
          <label>
            <span>Name</span>
            <input type="text" id="passkey-name" placeholder="This device" />
          </label>

          <button type="button" data-passkey="register">
            Add a passkey
          </button>
        </div>

        <h2>Registered</h2>

        {passkeys.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <ul>
            {passkeys.map((passkey) => (
              <li>
                <strong safe>{passkey.name}</strong>
                {passkey.deviceType ? <span safe> · {passkey.deviceType}</span> : null}
                {passkey.createdAt ? (
                  <span safe> · added {passkey.createdAt.slice(0, 10)}</span>
                ) : null}

                <form method="post" action="/settings/passkeys">
                  {csrfField()}
                  {methodField('DELETE')}
                  <input type="hidden" name="id" value={passkey.id} />

                  <button type="submit">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  )
}
