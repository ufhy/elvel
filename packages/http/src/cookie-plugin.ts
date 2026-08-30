import { Elysia } from 'elysia'
import { CookieBag, cookieRevealer, currentCookieBag, enterCookieBag } from './cookie-bag.ts'
import { CookieJar } from './cookies.ts'

export type CookieMiddlewareOptions = {
  /** Cookies that stay in the clear, by name. The session cookie is always one. */
  except?: readonly string[]
}

/**
 * Decrypt what came in, encrypt what goes out — Laravel's `EncryptCookies`.
 *
 * A cookie is the one piece of application state the user holds, and the only
 * thing standing between "remember this preference" and "remember that I am an
 * administrator" is whether the value can be edited. Encryption is what makes the
 * difference invisible at the call site: a handler queues a plain string and reads
 * a plain string back, and the client sees neither.
 *
 * `except` is for cookies something else has to read — an analytics script, a
 * front-end framework's XSRF token, or the session cookie, which is signed by the
 * session plugin and would otherwise be encrypted twice.
 *
 * With no encrypter bound the middleware still runs and still queues cookies; it
 * simply does not encrypt. That keeps `queueCookie()` working in an application
 * that has not registered `EncryptionServiceProvider` rather than failing at the
 * first cookie.
 */
export function cookiePlugin(jar: CookieJar, options: CookieMiddlewareOptions = {}) {
  const except = options.except ?? []

  // Decided once at boot: whether there is anything to decrypt at all, and how.
  const reveal = cookieRevealer(jar, except)

  return (
    new Elysia({ name: 'elvel:cookies' })
      /**
       * Synchronous, like the request scope: `enterWith` applies to the rest of the
       * current execution, and an `await` before it would put the bag out of reach
       * of the handler that wants to read a cookie.
       */
      .onBeforeHandle({ as: 'global' }, ({ request }) => {
        enterCookieBag(new CookieBag(CookieJar.parseOnce(request), reveal))
      })
      .onAfterHandle({ as: 'global' }, ({ set }) => {
        const bag = currentCookieBag()
        if (!bag) return

        const queued = bag.queued()
        if (queued.length === 0) return

        // Appended, never assigned: the session plugin has already put its own
        // cookie here, and replacing the header would sign everybody out.
        const existing = set.headers['set-cookie']
        const headers =
          existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]

        for (const { name, value, options: cookieOptions } of queued) {
          // A forget carries no value worth hiding, and encrypting an empty string
          // would only make the header longer.
          const shouldEncrypt = jar.encrypts && !except.includes(name) && value !== ''

          headers.push(
            CookieJar.serialize(
              name,
              shouldEncrypt ? jar.encrypt(name, value) : value,
              cookieOptions
            )
          )
        }

        set.headers['set-cookie'] = headers
      })
  )
}
