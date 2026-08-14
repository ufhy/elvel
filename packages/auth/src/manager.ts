import { AsyncLocalStorage } from 'node:async_hooks'
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
  private readonly storage = new AsyncLocalStorage<Scope>()

  /**
   * Sessions resolved for a request but not yet in scope.
   *
   * Keyed by the Request so nothing has to be added to Elysia's context, where
   * a key as ordinary as `session` would collide with the http package's own.
   */
  private readonly pending = new WeakMap<Request, AuthSession | null>()

  /** Set by `impersonate()`; `undefined` means "ask better-auth". */
  private impersonated: AuthSession | null | undefined

  constructor(private readonly auth: AuthInstance) {}

  /** Run `callback` with this request's session in scope. */
  async withSession<T>(request: Request, callback: () => Promise<T> | T): Promise<T> {
    return this.storage.run({ session: await this.resolve(request) }, callback)
  }

  /** Resolve this request's session and hold it until the scope is entered. */
  async remember(request: Request): Promise<void> {
    this.pending.set(request, await this.resolve(request))
  }

  /** The session resolved for this request, if `remember()` ran. */
  recall(request: Request): AuthSession | null {
    return this.pending.get(request) ?? null
  }

  /**
   * Put a session in scope for the rest of this async context.
   *
   * Elysia has no way to wrap a handler, so a `derive` cannot call
   * `storage.run()` around it. `enterWith` is the documented answer: it enters
   * the store for the remainder of the current execution, and each request runs
   * in its own async context, so two concurrent requests never see each other's
   * user.
   */
  enterScope(session: AuthSession | null, request?: Request): void {
    this.storage.enterWith(request === undefined ? { session } : { session, request })
  }

  /** Run `callback` with a session already in hand. Used by tests and commands. */
  runWith<T>(session: AuthSession | null, callback: () => Promise<T> | T): Promise<T> | T {
    return this.storage.run({ session }, callback)
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

  /** The current user, or null for a guest. */
  user(): AuthUser | null {
    return this.storage.getStore()?.session?.user ?? null
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

    const request = this.storage.getStore()?.request

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
    return this.storage.getStore()?.session?.session ?? null
  }

  /** Replace the session in the current scope, e.g. after signing in. */
  setSession(session: AuthSession | null): void {
    const scope = this.storage.getStore()
    if (scope) scope.session = session
  }

  /** The underlying better-auth instance, for its own API. */
  get instance(): AuthInstance {
    return this.auth
  }
}
