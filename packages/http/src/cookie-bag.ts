import { requestSlot } from '@elvel/core'
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
 * One object per request rather than a read bag and a write queue, because both
 * halves are the same short-lived thing
 * and keeping them together is what lets `cookie('theme')` read a value that this
 * same request queued a moment ago — otherwise a handler that sets a preference
 * and then renders with it would render the old one.
 */
export class CookieBag {
  private readonly outgoing = new Map<string, QueuedCookie>()

  /** Names already resolved through `reveal`; `undefined` is a real answer here. */
  private readonly revealed = new Map<string, string | undefined>()

  constructor(
    private readonly incoming: Record<string, string> = {},
    /**
     * How to turn one raw cookie into its value, called at most once per name.
     *
     * Omitted, the raw value *is* the value — which is the case with no encrypter
     * bound, and the reason an application without `EncryptionServiceProvider`
     * pays nothing for this at all.
     */
    private readonly reveal?: (name: string, value: string) => string | undefined
  ) {}

  /**
   * What the browser sent, decrypted on the way out rather than on the way in.
   *
   * Every incoming cookie used to be AEAD-decrypted as the request arrived, whether
   * or not the handler ever asked for one — 1.45µs each, so a page carrying four
   * application cookies and reading none of them paid 6.7µs to decrypt values it
   * threw away. A handler that reads one cookie now pays for one.
   *
   * The result is remembered, including the `undefined` a cookie that fails to
   * authenticate resolves to: that failure is not free either, and a template
   * reading the same cookie in a loop should not repeat it.
   */
  get(name: string, fallback?: string): string | undefined {
    const queued = this.outgoing.get(name)

    if (queued !== undefined) return queued.value

    if (this.revealed.has(name)) return this.revealed.get(name) ?? fallback

    const raw = this.incoming[name]

    if (raw === undefined) return fallback

    const value = this.reveal === undefined ? raw : this.reveal(name, raw)

    this.revealed.set(name, value)

    return value ?? fallback
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

  /**
   * Five years, which is what "forever" means to a browser: there is no such
   * attribute, so it is a date far enough out that nothing reaches it.
   */
  forever(name: string, value: string, options: CookieOptions = {}): this {
    return this.queue(name, value, { maxAge: 5 * 365 * 24 * 3600, ...options })
  }

  /**
   * `forget`, but not to be confused with it: this is the spelling that reads as
   * an intention rather than as a removal from a list.
   */
  expire(name: string, options: CookieOptions = {}): this {
    return this.forget(name, options)
  }

  /**
   * Has *this request* already queued it?
   *
   * How two pieces of code stop fighting over one cookie: a layout that sets a
   * default and a handler that set it deliberately would otherwise both write,
   * and the last one would win by accident.
   */
  hasQueued(name: string): boolean {
    return this.outgoing.has(name)
  }

  /** The queued cookie, or every one of them when no name is given. */
  queued(): QueuedCookie[]
  queued(name: string): QueuedCookie | undefined
  queued(name?: string): QueuedCookie[] | QueuedCookie | undefined {
    if (name === undefined) return [...this.outgoing.values()]

    return this.outgoing.get(name)
  }

  /** Take one back before the response is written. */
  unqueue(name: string): this {
    this.outgoing.delete(name)

    return this
  }
}

const slot = requestSlot<CookieBag>('cookie-bag')

/** Its own slot, so cookies work with sessions turned off. */
export function currentCookieBag(): CookieBag | undefined {
  return slot.get()
}

/** Must be called from a **synchronous** hook — see `scope.ts` for why. */
export function enterCookieBag(bag: CookieBag): void {
  slot.set(bag)
}

/** Run `body` with this bag current. For tests, and for anything not in a hook. */
export function withCookieBag<T>(bag: CookieBag, body: () => T): T {
  return slot.run(bag, body)
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

/** Queue the removal of a cookie. */
export function forgetCookie(name: string, options: CookieOptions = {}): void {
  currentCookieBag()?.forget(name, options)
}

/** Queue one for five years — the remember-me spelling. */
export function foreverCookie(name: string, value: string, options: CookieOptions = {}): void {
  currentCookieBag()?.forever(name, value, options)
}

/** Has this request already queued it? */
export function hasQueuedCookie(name: string): boolean {
  return currentCookieBag()?.hasQueued(name) ?? false
}

/** Take a queued cookie back. */
export function unqueueCookie(name: string): void {
  currentCookieBag()?.unqueue(name)
}

/**
 * How a bag should turn one raw cookie into its value.
 *
 * The same rule `readCookies` applies, expressed one cookie at a time so it can
 * be applied to the one cookie somebody actually asked for. Returns `undefined`
 * with no encrypter, which tells `CookieBag` there is nothing to do.
 */
export function cookieRevealer(
  jar: CookieJar,
  except: readonly string[]
): ((name: string, value: string) => string | undefined) | undefined {
  if (!jar.encrypts) return undefined

  return (name, value) => (except.includes(name) ? value : jar.decrypt(name, value))
}

/**
 * Parse a `Cookie` header, decrypting everything that is not excepted.
 *
 * The eager form. `cookiePlugin` no longer uses it — a request that reads no
 * cookie should decrypt no cookie — but it stays for code that wants the whole
 * set as a plain record and knows it will read most of it.
 */
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
