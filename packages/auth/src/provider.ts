import { ServiceProvider } from '@elvel/core'
import { middlewares, registerCurrentPasswordRule } from '@elvel/http'
import { Elysia } from 'elysia'
import { type Dialect, elvelAdapter } from './adapter.ts'
import { AuthSchemaCommand } from './console/auth-schema.ts'
import { AuthSecretCommand } from './console/auth-secret.ts'
import { MakePolicyCommand } from './console/make-policy.ts'
import { Gate } from './gate.ts'
import { authMailHooks, type Notifier, withAuthMail } from './mail-hooks.ts'
import { type AuthInstance, AuthManager } from './manager.ts'
import {
  authenticate,
  canAccess,
  ensureVerified,
  guestOnly,
  requirePassword
} from './middleware.ts'
import { type CacheLike, SessionRevocations } from './revocation.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    auth: AuthManager
    gate: Gate
  }
}

/** Everything `config/auth.ts` may set. Passed through to better-auth. */
export type AuthConfig = {
  /** Signs better-auth's own tokens. Required. */
  secret?: string
  baseURL?: string
  /** Where the auth endpoints live. Defaults to better-auth's `/api/auth`. */
  basePath?: string
  /** Database connection the auth tables live on. Defaults to the app's. */
  connection?: string
  /** Mount the auth endpoints. Off for an app that only needs the Gate. */
  mount?: boolean
  /**
   * Send the reset and verification links as notifications. On by default,
   * whenever `@elvel/notifications` is registered.
   */
  notifications?: boolean
  /**
   * better-auth's own rate limit, which guards the endpoints it mounts.
   *
   * Left alone it follows **`app.env`**, not `NODE_ENV`. better-auth's default is
   * `NODE_ENV === 'production'`, and an application deployed the way this framework
   * documents — `APP_ENV=production`, nothing said about `NODE_ENV` — left
   * `/api/auth/sign-in/email` with no limit at all while `throttle:6,1` guarded a
   * route the auth client never calls. Measured: twenty failed sign-ins in a row
   * answered `401` twenty times.
   *
   * Set it to override, including `{ enabled: false }` to turn it off in production
   * on purpose.
   */
  rateLimit?: { enabled?: boolean; window?: number; max?: number; [option: string]: unknown }
  /**
   * better-auth's session options, of which one has a framework opinion attached.
   *
   * **`cookieCache` is off, and turning it on is a real decision.** It puts the
   * session and the user row in a cookie so most requests need no store lookup:
   * measured on the `api` kit against Postgres 17, 50 concurrent sessions,
   * `get-session` goes from 6,664 req/s to 10,241. What it costs is that nothing
   * reads the store any more, so a revoked session keeps working until the cookie
   * expires.
   *
   * Turn it on and the framework closes that hole for you — see
   * {@link SessionRevocations}. A per-user epoch, bumped by better-auth's own
   * database hooks whenever a session, user or account changes, becomes the
   * cookie's `version`; a revoked session mismatches on its next request and the
   * store is read. That check plus the encryption below costs a tenth of the win:
   * 9,252 req/s against Redis, 8,853 against the file store — still well above
   * the 6,664 of no cache at all. Write your own `version` to take it over.
   *
   * `strategy` also defaults to `'jwe'` here rather than better-auth's
   * `'compact'`, which is base64 JSON — signed, but readable by anyone holding
   * the cookie, the user's own row included.
   */
  session?: {
    cookieCache?: {
      enabled?: boolean
      maxAge?: number
      strategy?: 'compact' | 'jwt' | 'jwe'
      version?: string | ((session: unknown, user: unknown) => string | Promise<string>)
      [option: string]: unknown
    }
    [option: string]: unknown
  }
  [option: string]: unknown
}

/**
 * Wires better-auth into the application, and the Gate on top of it.
 *
 * better-auth owns the credentials, sessions, providers and the endpoints that
 * go with them — that is a large, security-sensitive surface with a community
 * maintaining it. What the framework adds is the parts Laravel developers expect
 * around it: the auth tables live on our connection through our own adapter, the
 * current user is reachable anywhere in the request, and authorization goes
 * through a Gate with policies.
 */
export class AuthServiceProvider extends ServiceProvider {
  /**
   * The five aliases that need to know who is signed in.
   *
   * Registered here rather than in `@elvel/http`, which owns the registry but
   * must not depend on this package — an application with no authentication still
   * wants `throttle` and `signed`.
   *
   * Transcribed from `Illuminate\Auth\Middleware`, including the parts that look
   * wrong until you read why:
   *
   * - `auth` throws for JSON and redirects for a page, because a client that
   *   follows redirects would report the sign-in page as a successful answer
   * - `verified` treats a guest as unverified rather than deferring to `auth`, so
   *   a route carrying only `verified` does not fall open
   * - `password.confirm` answers **423** rather than 403: the caller is
   *   authenticated and the resource is locked, which is a different thing
   */
  private registerMiddleware(): void {
    middlewares()
      .alias('auth', (...guards: string[]) => authenticate(...guards))
      .alias('guest', (...guards: string[]) => guestOnly(...guards))
      .alias('verified', (notice?: string) => ensureVerified(notice))
      .alias('can', (ability: string, ...args: string[]) => canAccess(ability, ...args))
      .alias('password.confirm', (to?: string, seconds?: string) => requirePassword(to, seconds))
  }

  register(): void {
    this.registerMiddleware()

    // The gate is useful with or without better-auth mounted, and it resolves
    // the user lazily so it can be built before the auth instance exists.
    this.app.singleton('gate', (app) => {
      const events = () =>
        app.bound('events')
          ? (app.make('events' as never) as { dispatch(event: string, payload?: unknown): unknown })
          : undefined

      return new Gate(() => (app.bound('auth') ? app.make('auth').user() : null), events)
    })

    if (this.config<boolean>('auth.mount', true) === false) return

    // better-auth defends its own endpoints with trusted origins; our session
    // CSRF check would reject its cross-origin sign-in POSTs before they arrive.
    const basePath = this.config<string>('auth.basePath', '/api/auth')
    const except = this.app.config.get<string[]>('session.csrfExcept', [])

    this.app.config.set('session.csrfExcept', [...except, `${basePath}/*`])
  }

  override async boot(): Promise<void> {
    if (this.app.bound('elvel')) {
      this.app.make('elvel').register(AuthSchemaCommand, AuthSecretCommand, MakePolicyCommand)
    }

    /**
     * Policies are discovered before anything can authorise.
     *
     * The model registry is the same one the queue uses to rebuild payloads, so
     * a model reachable by a worker is reachable by a policy — one discovery
     * mechanism rather than two that can disagree.
     */
    if (this.app.bound('db')) {
      const models = (this.app.make('db' as never) as { models?: { get(name: string): unknown } })
        .models

      if (models) {
        await this.app.make('gate').discoverPolicies(this.app.appPath('Policies'), models)
      }
    }

    // `current_password` needs the signed-in user, so it can only be registered
    // where auth is: the standalone validator has no way to reach one.
    registerCurrentPasswordRule(this.app as never)

    const auth = await this.instance()
    const manager = new AuthManager(auth)

    this.app.instance('auth', manager)

    /**
     * Who is signed in, on the path that has no handler.
     *
     * The scope below is entered in `onBeforeHandle`, which an error response
     * never reaches: a deep link nothing matched is answered by the exception
     * handler, so an application rendering its own page there read `user()` as
     * guest and sent a signed-in visitor back to sign in. `remember()` ran for
     * that request in `onRequest`, so the session is already resolved — only the
     * scope is missing, and this puts it back.
     */
    if (this.app.bound('request.lifecycle')) {
      this.app.make('request.lifecycle').entering((request) => {
        manager.enterScope(manager.recall(request), request)
      })
    }

    if (this.config<boolean>('auth.mount', true) === false) return

    this.use(this.plugin(auth, manager))
  }

  /**
   * Build the better-auth instance against our own adapter.
   *
   * The dialect has to be resolved first: it decides whether booleans reach the
   * driver as booleans or as 0/1, and that is settled when the adapter is built,
   * not per query.
   */
  private async instance(): Promise<AuthInstance> {
    const config = this.app.config.get<AuthConfig>('auth', {})
    const { connection, mount, basePath, notifications, ...options } = config

    const db = this.app.make('db')
    const dialect = (await db.connection(connection)).grammar.dialect as Dialect

    /**
     * Loaded here, not at the top of the file.
     *
     * `better-auth` costs 65ms to evaluate, and an application registers the
     * provider in `config/app.ts` whether or not a request ever reaches an auth
     * route — so every CLI command and every boot paid it to build something they
     * would not use. This method is already async and already the only caller.
     */
    const { betterAuth } = await import('better-auth')

    return betterAuth({
      ...this.withMail(options, notifications),
      ...this.withRateLimit(options),
      ...this.withCookieCache(options),
      basePath: basePath ?? '/api/auth',
      database: elvelAdapter(db, { connection, dialect })
    }) as unknown as AuthInstance
  }

  /**
   * Make `session.cookieCache` revocable, for whoever turns it on.
   *
   * Off — which is what every kit ships — this adds nothing at all, and
   * better-auth is configured exactly as the application wrote it.
   *
   * On, three things are filled in that an application would otherwise have to
   * know to write itself:
   *
   * - `version` becomes the user's revocation epoch, so a cached cookie is
   *   thrown away and the store read the moment one of their sessions is revoked
   * - the database hooks that bump that epoch — session deleted, user updated or
   *   deleted, account updated, which is where a password change lands
   * - `strategy: 'jwe'`, because better-auth's default `'compact'` is base64
   *   JSON and putting the user's row in a cookie the client can read is a
   *   different decision from caching it
   *
   * Anything the application wrote wins, including its own `version` and its own
   * hooks — those are called first and then the epoch is bumped, rather than
   * replaced.
   */
  private withCookieCache(options: Record<string, unknown>): Record<string, unknown> {
    const session = options.session as Record<string, unknown> | undefined
    const cookieCache = session?.cookieCache as Record<string, unknown> | undefined

    if (cookieCache?.enabled !== true) return {}

    // better-auth's own fallback when `maxAge` is unset, and the epoch has to
    // outlive the cookie it invalidates or a stale cookie could match again.
    const maxAge = typeof cookieCache.maxAge === 'number' ? cookieCache.maxAge : 300

    const revocations = new SessionRevocations(
      () =>
        this.app.bound('cache')
          ? (this.app.make('cache' as never) as unknown as CacheLike)
          : undefined,
      maxAge + 60
    )

    return {
      session: {
        ...session,
        cookieCache: {
          strategy: 'jwe',
          ...cookieCache,
          version:
            cookieCache.version ??
            ((_session: unknown, user: unknown) =>
              revocations.epoch(String((user as { id?: unknown })?.id ?? '')))
        }
      },
      databaseHooks: this.withRevocationHooks(options, revocations)
    }
  }

  /**
   * The database hooks that bump the epoch, merged with the application's own.
   *
   * Hooks rather than endpoint middleware, so this covers the paths that never
   * see an HTTP request: a console command clearing sessions, a worker banning an
   * account. `delete.after` is handed the row that was deleted — including its
   * `userId` — and fires once per row of a `deleteMany`, so signing out of every
   * device bumps the epoch as surely as signing out of one.
   *
   * Four models, for four ways a session stops being good:
   *
   * - `session.delete` — signed out, revoked, or cleaned up as expired
   * - `user.update` — banned, or any other change to the row a cached cookie
   *   is carrying a copy of
   * - `user.delete` — the account is gone
   * - `account.update` — where a password change is written
   */
  private withRevocationHooks(
    options: Record<string, unknown>,
    revocations: SessionRevocations
  ): Record<string, unknown> {
    type Row = Record<string, unknown>
    type Hooks = Record<string, { delete?: Hook; update?: Hook } | undefined>
    type Hook = { after?: (row: Row, context: unknown) => unknown; [key: string]: unknown }

    const given = (options.databaseHooks ?? {}) as Hooks

    const bumping = (hook: Hook | undefined, owner: (row: Row) => unknown): Hook => ({
      ...hook,
      after: async (row: Row, context: unknown) => {
        await hook?.after?.(row, context)
        await revocations.revoke(String(owner(row) ?? ''))
      }
    })

    const byUserId = (row: Row) => row.userId
    const byId = (row: Row) => row.id

    return {
      ...given,
      session: { ...given.session, delete: bumping(given.session?.delete, byUserId) },
      user: {
        ...given.user,
        update: bumping(given.user?.update, byId),
        delete: bumping(given.user?.delete, byId)
      },
      account: { ...given.account, update: bumping(given.account?.update, byUserId) }
    }
  }

  /**
   * Make better-auth's rate limit follow this application's environment.
   *
   * better-auth decides for itself from `NODE_ENV === 'production'`. An Elvel
   * application says what environment it is in through `app.env`, and a deployment
   * that sets `APP_ENV=production` without `NODE_ENV` is the documented way to run
   * one — which left the endpoints better-auth mounts with no rate limit while
   * `throttle:6,1` guarded a route the auth client does not call. Twenty failed
   * sign-ins in a row answered `401` twenty times; they answer `429` after three
   * now.
   *
   * An explicit `auth.rateLimit` wins, so an application can still turn it off in
   * production or tighten it beyond the default.
   */
  private withRateLimit(options: Record<string, unknown>): Record<string, unknown> {
    const given = options.rateLimit as { enabled?: boolean } | undefined

    if (given?.enabled !== undefined) return {}

    return { rateLimit: { ...given, enabled: this.app.isProduction() } }
  }

  /**
   * Fill in better-auth's mail callbacks from the notification manager.
   *
   * better-auth builds the tokens and URLs and then asks the application to
   * deliver them — it ships no mailer on purpose. Without this an application
   * that turns on password resets gets an endpoint that logs "Reset password
   * isn't enabled" and returns a cheerful "check your email" to the user, which
   * is the worst of both: nothing sent, and nobody told.
   *
   * Only what the application has not written itself, and only when the
   * notification package is registered.
   */
  private withMail(
    options: Record<string, unknown>,
    enabled: boolean | undefined
  ): Record<string, unknown> {
    if (enabled === false || !this.app.bound('notifications')) return options

    const credentials = (options.emailAndPassword ?? {}) as { resetPasswordTokenExpiresIn?: number }

    return withAuthMail(
      options,
      authMailHooks({
        notifier: this.app.make('notifications' as never) as Notifier,
        appName: this.app.config.get<string>('app.name', 'Elvel'),
        // better-auth's own default, stated here so the mail can name it.
        resetExpiresIn: credentials.resetPasswordTokenExpiresIn ?? 3600
      })
    )
  }

  /**
   * Serve the auth endpoints, and put the session in scope for every request.
   *
   * A catch-all route rather than Elysia's `mount()`: mounting at `/` swallows
   * the application's own routes, and mounting at the base path rewrites the URL
   * to strip the prefix that better-auth matches on.
   *
   * `parse: 'none'` is what `mount()` sets too, and it is not optional — Elysia
   * would otherwise read the body to parse it, and better-auth would find the
   * stream already consumed and answer "Invalid JSON in request body".
   */
  private plugin(auth: AuthInstance, manager: AuthManager) {
    const basePath = this.config<string>('auth.basePath', '/api/auth')
    const handler = ({ request }: { request: Request }) => auth.handler(request)

    const plugin = new Elysia({ name: 'elvel:auth' })
      // Resolving is async and its result is held on the manager rather than
      // returned into the context: `session` there already belongs to the http
      // package, and shadowing it breaks session persistence.
      .onRequest(async ({ request }) => {
        await manager.remember(request)
      })
      /**
       * Deliberately synchronous.
       *
       * `enterWith` applies to the rest of the *current* execution, and an
       * `await` restores the frame the continuation was scheduled with — so
       * entering the scope inside the async `derive` above would be lost by the
       * time the handler runs. Elysia emits no `await` for a synchronous hook,
       * which is what carries the scope into the handler and everything it
       * calls. Verified by the request-isolation test in `test/auth.test.ts`.
       */
      .onBeforeHandle({ as: 'global' }, ({ request }) => {
        manager.enterScope(manager.recall(request), request)
      })
      .derive({ as: 'global' }, ({ request }) => ({
        auth: manager,
        user: manager.recall(request)?.user ?? null
      }))

    // Each verb is registered on its own rather than through `all()`: Elysia
    // treats an ALL route as a fallback, so a concrete `GET /*` elsewhere — the
    // static asset handler, for one — would answer the auth endpoints first.
    for (const path of [basePath, `${basePath}/*`]) {
      plugin.get(path, handler, { parse: 'none' })
      plugin.post(path, handler, { parse: 'none' })
      plugin.put(path, handler, { parse: 'none' })
      plugin.patch(path, handler, { parse: 'none' })
      plugin.delete(path, handler, { parse: 'none' })
      plugin.options(path, handler, { parse: 'none' })
    }

    return plugin
  }
}
