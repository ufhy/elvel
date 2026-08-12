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

type Scope = { session: AuthSession | null }

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
  enterScope(session: AuthSession | null): void {
    this.storage.enterWith({ session })
  }

  /** Run `callback` with a session already in hand. Used by tests and commands. */
  runWith<T>(session: AuthSession | null, callback: () => Promise<T> | T): Promise<T> | T {
    return this.storage.run({ session }, callback)
  }

  /** Ask better-auth who this request belongs to. */
  async resolve(request: Request): Promise<AuthSession | null> {
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
