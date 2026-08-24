import { passkeyClient } from '@better-auth/passkey/client'
import { createAuthClient } from 'better-auth/client'
import { ref } from 'vue'

/**
 * The one part of this application that has to run in the browser.
 *
 * Every other auth flow here is a form: it posts, the server calls better-auth's
 * server API, and answers. A passkey cannot work that way.
 * `navigator.credentials` is a browser API — the private key never leaves the
 * device, and the signature it produces can only be asked for by script on the
 * page.
 *
 * `createAuthClient` talks to the endpoints better-auth already mounts under
 * `config/auth.ts`'s `basePath`, on this same origin. No second API to keep in
 * step, and no token to store: it sets the same session cookie the sign-in form
 * would have.
 */
const client = createAuthClient({ plugins: [passkeyClient()] })

export function usePasskey(onSignedIn: (to: string) => void) {
  const working = ref(false)
  const error = ref('')

  /**
   * A WebAuthn failure is usually a cancellation.
   *
   * The prompt was dismissed, or this device has no key for this site.
   * `error.message` for those is a browser string nobody should have to read, so
   * each caller supplies the sentence and this only decides when to show it.
   */
  const attempt = async (work: () => Promise<{ error?: { message?: string } | null }>, said: string) => {
    working.value = true
    error.value = ''

    try {
      const { error: failed } = await work()

      if (failed) {
        error.value = failed.message ?? said

        return false
      }

      return true
    } catch {
      error.value = 'Your device did not complete the request.'

      return false
    } finally {
      working.value = false
    }
  }

  const signIn = async () => {
    if (await attempt(() => client.signIn.passkey(), 'No passkey matched this site.')) {
      onSignedIn('/dashboard')
    }
  }

  const register = async (name: string) =>
    attempt(() => client.passkey.addPasskey({ name: name.trim() || 'This device' }), 'That passkey was not added.')

  /**
   * Conditional UI — the passkey offered from the e-mail field itself.
   *
   * The browser only shows it if the field says `webauthn` in its `autocomplete`
   * *and* this call is in flight while the field is focused. Allowed to fail: a
   * browser without conditional mediation rejects it, and the button is still
   * there.
   */
  const offerFromField = () => {
    void client.signIn
      .passkey({ autoFill: true })
      .then(({ error: failed }) => {
        if (!failed) onSignedIn('/dashboard')
      })
      .catch(() => undefined)
  }

  return { working, error, signIn, register, offerFromField }
}
