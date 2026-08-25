import { user } from '@elvel/auth'
import { config } from '@elvel/core'
import { csrfToken } from '@elvel/http'

/**
 * Who is asking, and the token their next write needs.
 *
 * The first request a shell makes, and the reason a shell is possible at all. With
 * `spa.embed` off the document carries nothing — the same bytes for everybody, so
 * a cache may keep it — which means the two things every page needs have to be
 * asked for instead: who this is, and the CSRF token for this session.
 *
 * The token is safe to hand over here. It is `session.token()`, compared against
 * the session on every write, so a caller can only ever learn the token for the
 * session it already holds the cookie for. What it is *not* is a bearer token:
 * possessing it without the cookie authorises nothing.
 *
 * Read again after signing in. Signing in rotates the session id — session
 * fixation — and the token rotates with it, so a token fetched before is no longer
 * the one the server expects.
 *
 * **No guard, and that is the point.** A guest needs this more than anybody: the
 * shell carries no CSRF token — a token is per session, and a document carrying
 * one could not be cached — so without an unguarded way to fetch it the sign-in
 * form has nothing to post. Measured as `419 CSRF token mismatch` on a fresh
 * visit.
 *
 * `user: null` is a real answer here, not a failure. What guards the application
 * is the document route: `routes/spa.ts` puts `auth` on `/dashboard`, so a guest
 * is turned away before any of its JavaScript loads and nothing behind this
 * endpoint depends on it saying no.
 */
export default class SessionController {
  show() {
    const person = user()

    return {
      app: config('app.name', 'Elvel'),
      user:
        person === null
          ? null
          : {
              id: person.id,
              name: person.name,
              email: person.email,
              emailVerified: person.emailVerified === true
            },
      csrf: csrfToken()
    }
  }
}
