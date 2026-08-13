import { AsyncLocalStorage } from 'node:async_hooks'
import { CookieJar, type CookieOptions } from './cookies.ts'

/** A cookie waiting to go out with the response. */
export type QueuedCookie = {
  name: string
  value: string
  options: CookieOptions
}

/**
 * The cookies of one request: what came in, and what is going out.
 *
 * Laravel splits this between the request bag and the `CookieJar` queue. Here it
 * is one object per request, because both halves are the same short-lived thing
 * and keeping them together is what lets `cookie('theme')` read a value that this
 * same request queued a moment ago — otherwise a handler that sets a preference
 * and then renders with it would render the old one.
 */
export class CookieBag {
  private readonly outgoing = new Map<string, QueuedCookie>()

  constructor(private readonly incoming: Record<string, string> = {}) {}

  /** What the browser sent, already decrypted. */
  get(name: string, fallback?: string): string | undefined {
    return this.outgoing.get(name)?.value ?? this.incoming[name] ?? fallback
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** Send this cookie with the response. */
  queue(name: string, value: string, options: CookieOptions = {}): this {
    this.outgoing.set(name, { name, value, options })

    return this
  }

  /**
   * Ask the browser to drop this cookie.
   *
   * An expiry in the past with an empty value, and the same `path`/`domain` as
   * when it was set — a browser matches on those, so a cookie set for `/admin`
   * survives a forget aimed at `/` and the user stays logged in to something you
   * thought you had cleared.
   */
  forget(name: string, options: CookieOptions = {}): this {
    return this.queue(name, '', { ...options, maxAge: 0, expires: new Date(0) })
  }

  queued(): QueuedCookie[] {
    return [...this.outgoing.values()]
  }
}

const storage = new AsyncLocalStorage<CookieBag>()

/** Its own storage, so cookies work with sessions turned off. */
export function currentCookieBag(): CookieBag | undefined {
  return storage.getStore()
}

/** Must be called from a **synchronous** hook — see `scope.ts` for why. */
export function enterCookieBag(bag: CookieBag): void {
  storage.enterWith(bag)
}

/** Run `body` with this bag current. For tests, and for anything not in a hook. */
export function withCookieBag<T>(bag: CookieBag, body: () => T): T {
  return storage.run(bag, body)
}

/**
 * Read a cookie sent with this request — `cookie('theme')`.
 *
 * Encrypted cookies arrive decrypted; one that fails to decrypt reads as absent,
 * which is what turns a rotated key into "the preference reset" rather than an
 * exception on every page.
 */
export function cookie(name: string, fallback?: string): string | undefined {
  return currentCookieBag()?.get(name, fallback) ?? fallback
}

/** Queue a cookie for the response — `Cookie::queue()`. */
export function queueCookie(name: string, value: string, options: CookieOptions = {}): void {
  currentCookieBag()?.queue(name, value, options)
}

/** Queue the removal of a cookie — `Cookie::forget()`. */
export function forgetCookie(name: string, options: CookieOptions = {}): void {
  currentCookieBag()?.forget(name, options)
}

/** Parse a `Cookie` header, decrypting everything that is not excepted. */
export function readCookies(
  header: string | null | undefined,
  jar: CookieJar,
  except: readonly string[]
): Record<string, string> {
  const raw = CookieJar.parse(header)

  if (!jar.encrypts) return raw

  const plain: Record<string, string> = {}

  for (const [name, value] of Object.entries(raw)) {
    if (except.includes(name)) {
      plain[name] = value

      continue
    }

    const decrypted = jar.decrypt(name, value)

    // A cookie that does not authenticate is dropped rather than passed through
    // raw: handing the handler ciphertext it would treat as a value is worse than
    // handing it nothing, and passing through an *unencrypted* value here is
    // exactly how a forged cookie would get itself accepted.
    if (decrypted !== undefined) plain[name] = decrypted
  }

  return plain
}
