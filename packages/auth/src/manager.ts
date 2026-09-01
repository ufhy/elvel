import { requestSlot } from '@elvel/core'
import type { AuthUser } from './gate.ts'

/** The shape better-auth's `getSession` returns, narrowed to what we rely on. */
export type AuthSession = {
  user: AuthUser
  session: Record<string, unknown> & { id: string; token?: string; expiresAt?: Date }
}

/** The better-auth instance, structurally — the package types it far wider. */
export type AuthInstance = {
  handler(request: Request): Promise<Response>
  api: {
    getSession(args: { headers: Headers }): Promise<AuthSession | null>
  }
}

/** What the request scope carries. `request` is what a named guard reads. */
type Scope = { session: AuthSession | null; request?: Request }

/**
 * The authenticated user for the request in flight.
 *
 * Laravel reaches the current user through a request-scoped container binding.
 * There is no such thing here, so the request scope is an `AsyncLocalStorage`:
 * anything called from a handler — a policy, a model observer, a queued closure
 * resolved inline — can ask who the user is without that being threaded through
 * every signature. Outside a request there is simply no scope, and `user()`
 * returns null rather than leaking the last request's user.
 */
export class AuthManager {
  /**
   * A slot in the one request context, not a storage of its own.
   *
   * Per instance rather than per module, which `requestSlot` gives for free — it
   * mints a fresh symbol on every call, so two managers in one test suite do not
   * read each other's sessions. `request-context.ts` says why there is a single
   * context underneath them all.
   */
  private readonly slot = requestSlot<Scope>('auth-session')

  /**
   * Sessions resolved for a request but not yet in scope.
   *
   * Keyed by the Request so nothing has to be added to Elysia's context, where
   * a key as ordinary as `session` would collide with the http package's own.
   */
  private readonly pending = new WeakMap<Request, AuthSession | null>()

  /** Set by `impersonate()`; `undefined` means "ask better-auth". */
  private impersonated: AuthSession | null | undefined

  /**
   * The cookie names better-auth would put a session in, read from the instance.
   *
   * Read once and lazily, because reading it is `await auth.$context` — the same
   * context resolving the session would use, so the first request pays for it
   * either way and every request after pays nothing.
   */
  private tokens: string[] | undefined

  constructor(private readonly auth: AuthInstance) {}

  /** Run `callback` with this request's session in scope. */
  async withSession<T>(request: Request, callback: () => Promise<T> | T): Promise<T> {
    return this.slot.run({ session: await this.resolve(request) }, callback)
  }

  /**
   * Resolve this request's session and hold it until the scope is entered.
   *
   * Asks better-auth only when the request could be carrying a session. Resolving
   * one costs **10.4µs**, and it was paid by every request — a health check with no
   * cookie at all included, which is more than the whole framework's request
   * pipeline costs (3.9µs). Measured by stacking the providers one at a time: an
   * application went from 4.4µs to 14.8µs per request the moment the auth
   * endpoints were mounted.
   *
   * What "could be carrying" means is asked precisely rather than guessed at: the
   * cookie names come from better-auth's own context, and the `Authorization`
   * header is included because the `bearer` plugin puts a session there — a guard
   * that only looked at cookies would have made token authentication stop working
   * and said nothing about it.
   */
  async remember(request: Request): Promise<void> {
    if (this.impersonated === undefined && !(await this.mayCarrySession(request))) {
      this.pending.set(request, null)

      return
    }

    this.pending.set(request, await this.resolve(request))
  }

  /**
   * Could this request be carrying a session at all?
   *
   * A session reaches better-auth through one of its cookies or through the
   * `Authorization` header. Neither present means there is nothing to resolve, and
   * `null` is the same answer `getSession` would have spent 10µs arriving at.
   */
  private async mayCarrySession(request: Request): Promise<boolean> {
    if (request.headers.get('authorization') !== null) return true

    const cookie = request.headers.get('cookie')

    if (cookie === null) return false

    const names = await this.sessionCookieNames()

    // Nothing to match against: pass it through rather than decide it is a guest.
    // Slower, never wrong — and the alternative silently signs people out.
    if (names.length === 0) return true

    for (const name of names) {
      if (cookie.includes(name)) return true
    }

    return false
  }

  /**
   * The cookie names better-auth uses, or `[]` if it will not say.
   *
   * An empty list means every request with any cookie is passed through to
   * `getSession` — slower, never wrong. Guessing `better-auth.session_token`
   * instead would break the moment an application sets `advanced.cookiePrefix`.
   */
  private async sessionCookieNames(): Promise<string[]> {
    if (this.tokens !== undefined) return this.tokens

    try {
      const context = await (this.auth as unknown as { $context: Promise<unknown> }).$context
      const cookies = (context as { authCookies?: Record<string, { name?: string }> }).authCookies

      this.tokens = Object.values(cookies ?? {})
        .map((cookie) => cookie?.name)
        .filter((name): name is string => typeof name === 'string')
    } catch {
      this.tokens = []
    }

    return this.tokens
  }

  /** The session resolved for this request, if `remember()` ran. */
  recall(request: Request): AuthSession | null {
    return this.pending.get(request) ?? null
  }

  /**
   * Put a session in scope for the rest of this async context.
   *
   * Elysia has no way to wrap a handler, so a `derive` cannot call
   * `slot.run()` around it. `enterWith` is the documented answer: it enters
   * the store for the remainder of the current execution, and each request runs
   * in its own async context, so two concurrent requests never see each other's
   * user.
   */
  enterScope(session: AuthSession | null, request?: Request): void {
    this.slot.set(request === undefined ? { session } : { session, request })
  }

  /** Run `callback` with a session already in hand. Used by tests and commands. */
  runWith<T>(session: AuthSession | null, callback: () => Promise<T> | T): Promise<T> | T {
    return this.slot.run({ session }, callback)
  }

  /**
   * Resolve every request as this session, whatever its cookies say.
   *
   * What `actingAs` needs, and the only honest way to give it: the alternative
   * is signing a user in for real on every test, which needs a user row, a
   * password, and a round trip — enough friction that tests stop covering
   * authenticated routes. Laravel's `be()` makes the same trade.
   *
   * Deliberately a method on the manager rather than a header the test sets: a
   * header would be a live authentication bypass shipped in the framework, and
   * this cannot be reached from outside the process.
   */
  impersonate(session: AuthSession | null): void {
    this.impersonated = session
  }

  /** Undo `impersonate()`, going back to the request's own cookies. */
  stopImpersonating(): void {
    this.impersonated = undefined
  }

  /** Ask better-auth who this request belongs to. */
  async resolve(request: Request): Promise<AuthSession | null> {
    if (this.impersonated !== undefined) return this.impersonated

    try {
      return await this.auth.api.getSession({ headers: request.headers })
    } catch {
      // A malformed or expired cookie is a guest, not a server error.
      return null
    }
  }

  /**
   * The current user, or null for a guest.
   *
   * The request scope first, then an impersonation. The order matters: inside a
   * request the scope holds the session that request resolved, which is already
   * the impersonated one when there is one.
   *
   * The fallback is what makes `actingAs` usable outside a handler. Without it
   * `auth().user()` and every helper built on it — `can()`, `cannot()`, a policy
   * — answered "guest" when called directly in a test that had just said who was
   * acting, while the same call *inside* a pressed request answered correctly.
   * That split is invisible until somebody writes the first application test.
   */
  user(): AuthUser | null {
    const scoped = this.slot.get()?.session

    if (scoped !== undefined) return scoped?.user ?? null

    return this.impersonated?.user ?? null
  }

  /**
   * A named guard — `auth().guard('api').user()`.
   *
   * There is one session-backed guard, because better-auth models sessions
   * itself and a second copy of that would be a second source of truth. What a
   * second guard *is* for is a different way of **identifying** the caller for
   * the same request: a bearer token from a mobile client, a signed service
   * token between two of your own services.
   *
   * A guard is registered with a resolver that reads the request and answers
   * with a user or null. Nothing is cached across requests — the resolver runs
   * per request, in the scope, so a token that was revoked a second ago is not
   * still trusted.
   */
  extend(name: string, resolver: (request: Request) => Promise<AuthUser | null>): this {
    this.guards.set(name, resolver)

    return this
  }

  /** The guard to ask. The default is the session-backed one. */
  guard(name?: string): {
    user(): Promise<AuthUser | null>
    check(): Promise<boolean>
    id(): Promise<string | number | null>
  } {
    if (name === undefined || name === 'session') {
      const user = this.user()

      return {
        user: async () => user,
        check: async () => user !== null,
        id: async () => user?.id ?? null
      }
    }

    const resolver = this.guards.get(name)

    if (!resolver) {
      const known = ['session', ...this.guards.keys()].join(', ')

      throw new Error(`Auth guard [${name}] is not defined. Known guards: ${known}.`)
    }

    const request = this.slot.get()?.request

    if (!request) {
      // A guard reads the request; outside one there is nothing to read, and
      // answering "no user" would be indistinguishable from a real refusal.
      throw new Error(`Guard [${name}] can only be used inside a request.`)
    }

    const resolve = async () => resolver(request)

    return {
      user: resolve,
      check: async () => (await resolve()) !== null,
      id: async () => (await resolve())?.id ?? null
    }
  }

  private readonly guards = new Map<string, (request: Request) => Promise<AuthUser | null>>()

  id(): string | number | null {
    return this.user()?.id ?? null
  }

  check(): boolean {
    return this.user() !== null
  }

  guest(): boolean {
    return !this.check()
  }

  /** The session record itself — token, expiry, ip. */
  session(): AuthSession['session'] | null {
    const scoped = this.slot.get()?.session

    // The same fallback as `user()`, and for the same reason: the two must agree
    // about who is acting, or a check reads the user from one and the session id
    // from the other.
    if (scoped !== undefined) return scoped?.session ?? null

    return this.impersonated?.session ?? null
  }

  /** Replace the session in the current scope, e.g. after signing in. */
  setSession(session: AuthSession | null): void {
    const scope = this.slot.get()
    if (scope) scope.session = session
  }

  /** The underlying better-auth instance, for its own API. */
  get instance(): AuthInstance {
    return this.auth
  }
}
