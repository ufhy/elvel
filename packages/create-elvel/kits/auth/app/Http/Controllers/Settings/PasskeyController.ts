import { api, messageFrom } from '@elvel/auth'
import { errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { Passkeys } from '../../../../resources/views/pages/settings/passkeys.tsx'

/** What the page needs about one credential. Everything else is device detail. */
export type PasskeyRow = {
  id: string
  name: string
  createdAt?: string
  deviceType?: string
}

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
  async index({ request, query }: { request: Request; query: Record<string, string | undefined> }) {
    const listed = (await api().listPasskeys({ headers: request.headers })) as unknown

    return view(Passkeys, {
      title: 'Passkeys',
      passkeys: rowsFrom(listed),
      removed: query.removed === '1',
      error: errors().first()
    })
  }

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
function rowsFrom(listed: unknown): PasskeyRow[] {
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
