import { api, sessionSummaries, user, userOf } from '@elvel/auth'
import { currentScope } from '@elvel/http'

/** One passkey, as a page needs it — and not the row better-auth stores. */
function passkeyRows(listed: unknown) {
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

/**
 * What the settings screens read.
 *
 * Four endpoints rather than four page payloads, which is the difference between a
 * single-page application and a server-driven one. A payload belongs to the
 * document it was embedded in, so a client navigation arrives with the previous
 * page's data; a request belongs to the page that made it.
 *
 * The guards in `routes/spa.ts` are the same ones the pages themselves are behind.
 * `password.confirm` on three of them is not caution: reading which devices are
 * signed in, and the secret of an enrolment in progress, is where a borrowed
 * unlocked browser does real damage.
 */
export default class SettingsController {
  profile(context: object) {
    const person = userOf(context as never)

    return { name: person.name, email: person.email, emailVerified: person.emailVerified }
  }

  async sessions({ request }: { request: Request }) {
    return {
      sessions: sessionSummaries(
        (await api().listSessions({ headers: request.headers })) as unknown,
        request.headers
      )
    }
  }

  async passkeys({ request }: { request: Request }) {
    return {
      passkeys: passkeyRows((await api().listPasskeys({ headers: request.headers })) as unknown)
    }
  }

  twoFactor() {
    return {
      enabled: user()?.twoFactorEnabled === true,
      /**
       * The enrolment in progress, flashed by the step before it.
       *
       * In the session for exactly one request: the secret and the ten recovery
       * codes are shown once and never again. Reading it here consumes it, which
       * is the same contract the server-rendered page had.
       */
      pending: currentScope()?.session.get('two-factor.pending') as
        | { uri: string; secret: string; codes: string[] }
        | undefined
    }
  }
}
