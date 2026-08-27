import { api, messageFrom } from '@elvel/auth'
import { redirect } from '@elvel/http'

/** What the page needs about one credential. Everything else is device detail. */
export type PasskeyRow = {
  id: string
  name: string
  createdAt?: string
  deviceType?: string
}

/**
 * This kit's own copy, with the page removed.
 *
 * The auth layer's version of this class renders a screen *and* performs the
 * action, so it imports its `.tsx` page at the top of the module — and that import
 * is evaluated the moment a routes file mentions the class, whether or not the
 * page method is ever routed. This kit renders its screens in Vue, so carrying
 * that layer's file meant carrying an empty `.tsx` beside it purely to satisfy an
 * import. Measured: delete the page and the application dies at load.
 *
 * So the actions live here instead, copied verbatim, and nothing in this kit
 * imports a page it does not render. The cost is a copy: an action fixed in the
 * auth kit has to be fixed here too.
 */
/**
 * The passkeys registered against this account.
 *
 * Registering one is the browser's job — `resources/js/passkeys.ts` asks the
 * device to create a key, because a private key that a server could produce would
 * not be a passkey. **Listing and removing them is not**: both are ordinary
 * requests, so they are an ordinary page and an ordinary form, and they keep
 * working with JavaScript off.
 *
 * `routes/settings.ts` puts these behind `password.confirm`, like the rest of the
 * security settings: adding a way into an account, or taking the last one away, is
 * exactly what somebody with a borrowed unlocked browser would do.
 */
export default class PasskeyController {
  async destroy({ body, request }: { body: { id: string }; request: Request }) {
    const answer = await api().deletePasskey({
      body: { id: body.id },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      return redirect('/settings/passkeys')
        .withErrors({ passkey: await messageFrom(answer, 'That passkey was not removed.') })
        .toResponse()
    }

    return redirect('/settings/passkeys?removed=1').seeOther().toResponse()
  }
}

/**
 * Narrow what better-auth listed into what the page renders.
 *
 * `listPasskeys` is typed as widely as the rest of the server API — the row shape
 * depends on the plugin's schema, which an application may extend — so the page
 * gets a shape it can rely on and anything unrecognisable is dropped rather than
 * rendered as `undefined`.
 */
function _rowsFrom(listed: unknown): PasskeyRow[] {
  if (!Array.isArray(listed)) return []

  return listed.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []

    const row = entry as Record<string, unknown>

    if (typeof row.id !== 'string') return []

    return [
      {
        id: row.id,
        // A passkey registered without a name is still a passkey.
        name: typeof row.name === 'string' && row.name.trim() ? row.name : 'Unnamed passkey',
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : undefined,
        deviceType: typeof row.deviceType === 'string' ? row.deviceType : undefined
      }
    ]
  })
}
