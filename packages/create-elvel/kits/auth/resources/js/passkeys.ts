import { passkeyClient } from '@better-auth/passkey/client'
import { createAuthClient } from 'better-auth/client'

/**
 * The one part of this application that has to run in the browser.
 *
 * Everything else here is a form: the server takes the request, calls
 * better-auth's server API, and answers with a redirect. A passkey cannot work
 * that way. `navigator.credentials` is a browser API — the private key never
 * leaves the device, and the signature it produces can only be asked for by
 * script running on the page. So this file exists, and nothing else needs to.
 *
 * `createAuthClient` talks to the endpoints better-auth already mounts under
 * `config/auth.ts`'s `basePath`, on this same origin. There is no second API to
 * keep in step, and no token to store — it sets the same session cookie the sign-in
 * form would have.
 */
const client = createAuthClient({ plugins: [passkeyClient()] })

/** Where the browser goes once a passkey has identified somebody. */
const AFTER_SIGN_IN = '/dashboard'

/**
 * Say what went wrong, in the place the page set aside for it.
 *
 * A WebAuthn failure is usually a cancellation — the prompt was dismissed, or the
 * device has no key for this site — and `error.message` for those is a browser
 * string nobody should have to read. So the element carries the sentence and this
 * only fills it in.
 */
function report(target: string, message: string): void {
  const element = document.querySelector<HTMLElement>(target)

  if (!element) return

  element.textContent = message
  element.hidden = false
}

function busy(button: HTMLButtonElement, working: boolean): void {
  button.disabled = working
  button.setAttribute('aria-busy', String(working))
}

/**
 * Register a passkey for the account already signed in.
 *
 * The name is what the settings page will list it under — "MacBook", "phone" —
 * and better-auth stores it against the credential.
 */
async function register(button: HTMLButtonElement): Promise<void> {
  /**
   * Found by id, not by a data attribute.
   *
   * The styled kit renders this field through its `Input` component, which sets
   * `id` from the field name and has nowhere to put a `data-` attribute. An id
   * both kits can agree on is the smaller arrangement.
   */
  const field = document.querySelector<HTMLInputElement>('#passkey-name')
  const name = field?.value.trim() || 'This device'

  busy(button, true)

  try {
    const { error } = await client.passkey.addPasskey({ name })

    if (error) {
      report('[data-passkey-error]', error.message ?? 'That passkey was not added.')

      return
    }

    // Reloaded rather than patched into the list: the server renders the list, so
    // asking it again is both simpler and the only version that cannot disagree.
    window.location.reload()
  } catch {
    report('[data-passkey-error]', 'Your device did not complete the request.')
  } finally {
    busy(button, false)
  }
}

/** Sign in with a passkey, with no e-mail address typed at all. */
async function signIn(button: HTMLButtonElement): Promise<void> {
  busy(button, true)

  try {
    const { error } = await client.signIn.passkey()

    if (error) {
      report('[data-passkey-error]', error.message ?? 'No passkey matched this site.')

      return
    }

    window.location.href = AFTER_SIGN_IN
  } catch {
    report('[data-passkey-error]', 'Your device did not complete the request.')
  } finally {
    busy(button, false)
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  const button = target?.closest<HTMLButtonElement>('[data-passkey]')

  if (!button) return

  event.preventDefault()

  if (button.dataset.passkey === 'register') void register(button)
  if (button.dataset.passkey === 'sign-in') void signIn(button)
})

/**
 * Conditional UI — the passkey offered from the e-mail field itself.
 *
 * The browser only shows it if the field says `webauthn` in its `autocomplete`,
 * and only if this call is in flight when the field is focused. It is allowed to
 * fail: a browser without conditional mediation rejects it, and the button is
 * still there.
 */
if (document.querySelector('[data-passkey-autofill]')) {
  void client.signIn
    .passkey({ autoFill: true })
    .then(({ error }) => {
      if (!error) window.location.href = AFTER_SIGN_IN
    })
    .catch(() => undefined)
}
