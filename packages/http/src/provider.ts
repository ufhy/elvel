import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushDeferred, ServiceProvider } from '@elvel/core'
import { Elysia } from 'elysia'
import { BindingRegistry, resolveBindings } from './bindings.ts'
import { MakeRequestCommand } from './console/make-request.ts'
import { MakeResourceCommand } from './console/make-resource.ts'
import { MiddlewareListCommand } from './console/middleware-list.ts'
import { SessionGcCommand } from './console/session-gc.ts'
import { SessionTableCommand } from './console/session-table.ts'
import { cookiePlugin } from './cookie-plugin.ts'
import { CookieJar } from './cookies.ts'
import {
  actualHeaders,
  type CorsConfig,
  type CorsOverride,
  corsConfig,
  corsFor,
  isCorsRequest,
  isPreflight,
  pathMatches,
  preflightHeaders
} from './cors.ts'
import { TokenMismatchError, tokensMatch } from './csrf.ts'
import { maintenancePlugin } from './maintenance.ts'
import { methodOverridePlugin } from './method-override.ts'
import { MiddlewareRegistry } from './middleware.ts'
import { PREVIOUS_URL_KEY } from './redirect.ts'
import { RouteRegistry } from './routes.ts'
import { enterRequestScope } from './scope.ts'
import { newNonce, type SecurityConfig, securityHeaders } from './security.ts'
import { FileSessionDriver, MemorySessionDriver, Session, type SessionDriver } from './session.ts'
import { CacheSessionDriver, DatabaseSessionDriver } from './session-drivers.ts'
import { hasValidSignature, InvalidSignatureError } from './signed-url.ts'
import { enforceThrottle, LimiterRegistry } from './throttle.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    'session.driver': SessionDriver
    /** This response's security headers, for a package that answers its own. */
    'security.headers': (request: Request) => Record<string, string>
    cookies: CookieJar
    limiters: LimiterRegistry
    routes: RouteRegistry
  }
}

/**
 * Wires sessions, signed cookies and CSRF into the request lifecycle, and turns
 * a `ValidationError` into a 422 with the error bag.
 */
export class HttpServiceProvider extends ServiceProvider {
  /**
   * The middleware registry, and the aliases this package owns.
   *
   * `auth`, `guest`, `verified`, `can` and `password.confirm` are registered by
   * `@elvel/auth` instead — this package must not depend on it, and an
   * application without authentication should still have `throttle` and `signed`.
   *
   * The priority list is set here because it is the whole application's order,
   * not one package's: `auth` must run before `verified`, and `verified` before
   * `password.confirm`, whatever order a route lists them in.
   */
  private registerMiddleware(): void {
    this.app.singleton('bindings', () => new BindingRegistry())

    this.app.singleton('middleware', () => {
      const registry = new MiddlewareRegistry()

      registry
        .alias('throttle', (max?: string, decay?: string) => {
          // `throttle:uploads` names a limiter; `throttle:6,1` gives the numbers.
          const named = max !== undefined && decay === undefined && Number.isNaN(Number(max))

          return (context) =>
            enforceThrottle(
              context as never,
              named ? max : undefined,
              named
                ? {}
                : {
                    max: max === undefined ? undefined : Number(max),
                    decay: decay === undefined ? undefined : Number(decay) * 60
                  }
            )
        })
        .alias('signed', (relative?: string) => (context) => {
          const { request } = context as unknown as { request: Request }

          if (hasValidSignature(request, relative !== 'relative')) return undefined

          throw new InvalidSignatureError()
        })
        /**
         * `bindings` — turn route parameters into models.
         *
         * A middleware rather than something automatic, as Laravel's
         * `SubstituteBindings` is: a route that takes an id and does not want it
         * loaded should not pay for a query, and an API that answers from a cache
         * may never touch the row at all.
         */
        .alias('bindings', () => async (context) => {
          const { request, params } = context as unknown as {
            request: Request
            params: Record<string, string>
          }

          await resolveBindings(this.app.make('bindings'), params ?? {}, request)

          return undefined
        })
        .alias('cache.headers', (...parts: string[]) => (context) => {
          // `cache.headers:public;max_age=120` — Laravel's own separator is `;`.
          const value = parts.join(',').replace(/;/g, ', ').replace(/_/g, '-')
          const set = (context as unknown as { set: { headers: Record<string, string> } }).set
          set.headers['cache-control'] = value

          return undefined
        })
        /**
         * `bindings` runs after the guards and before `can`.
         *
         * Loading a row for somebody who is about to be turned away is work for
         * nothing, and `can:update,article` needs the article already resolved.
         */
        .priority(['throttle', 'signed', 'auth', 'verified', 'password.confirm', 'bindings', 'can'])

      return registry
    })
  }

  register(): void {
    this.registerMiddleware()

    this.app.singleton('session.driver', (app) => {
      const driver = this.config<string>('session.driver', 'file')

      if (driver === 'memory') return new MemorySessionDriver()

      if (driver === 'file') {
        return new FileSessionDriver(
          this.config('session.path', join(app.storagePath('framework'), 'sessions'))
        )
      }

      /**
       * A table, so more than one process can share a session.
       *
       * The moment an application runs in two containers, a file session lives on
       * whichever machine wrote it and people are logged out at random.
       */
      if (driver === 'database') {
        if (!app.bound('db')) {
          throw new Error(
            'The database session driver needs DatabaseServiceProvider. Register it, then run: elvel session:table && elvel migrate'
          )
        }

        const table = this.config<string>('session.table', 'sessions')
        const connection = this.config<string | undefined>('session.connection', undefined)

        return new DatabaseSessionDriver(() => app.make('db').table(table, connection) as never)
      }

      // `redis` is the cache driver by another name, exactly as in Laravel: any
      // configured store will do, and the store's own expiry does the collecting.
      if (driver === 'redis' || driver === 'cache') {
        if (!app.bound('cache')) {
          throw new Error(
            `The ${driver} session driver needs CacheServiceProvider. Register it in config/app.ts.`
          )
        }

        const store = this.config<string | undefined>(
          'session.store',
          driver === 'redis' ? 'redis' : undefined
        )

        return new CacheSessionDriver(
          app.make('cache').store(store) as never,
          this.config<number>('session.lifetime', 7200)
        )
      }

      throw new Error(
        `Session driver [${driver}] is not supported. Use file, database, redis, cache or memory.`
      )
    })

    this.app.singleton('cookies', (app) => {
      const key = this.config<string>('app.key', '')

      if (key === '') {
        throw new Error('Set APP_KEY (32+ characters) before using signed cookies or sessions.')
      }

      // Encryption is optional: without the encryption package a jar still signs,
      // and `encrypt()` says what to register rather than failing obscurely.
      return new CookieJar(key, app.bound('encrypter') ? app.make('encrypter') : undefined)
    })

    // Registered rather than booted: a provider's `boot()` is where an
    // application defines its limiters, and half of those run before this one.
    this.app.singleton('limiters', () => new LimiterRegistry())

    // Same reason: controllers name their routes while they are being mounted,
    // which happens before this provider boots.
    this.app.singleton('routes', () => {
      const registry = new RouteRegistry()
      registry.origin = this.config<string>('app.url', '').replace(/\/$/, '')

      return registry
    })
  }

  override async boot(): Promise<void> {
    if (this.app.bound('elvel')) {
      this.app
        .make('elvel')
        .register(
          MakeRequestCommand,
          MakeResourceCommand,
          MiddlewareListCommand,
          SessionGcCommand,
          SessionTableCommand
        )
    }

    /**
     * First, before anything else: an application that is down should not be
     * starting sessions, checking CSRF or counting rate limits for requests it is
     * about to refuse.
     */
    /**
     * Before everything, including maintenance mode.
     *
     * It rewrites the request rather than reading it, so anything registered
     * earlier would see a `POST` that the router is about to treat as a `PUT` —
     * and a CSRF check that ran on the wrong method is a check on the wrong
     * question.
     */
    if (this.config<boolean>('http.methodOverride', true) !== false) {
      this.use(
        methodOverridePlugin((request) => this.app.router.handle(request), {
          allow: this.config<string[] | undefined>('http.methodOverrideAllow', undefined),
          fromQuery: this.config<boolean>('http.methodOverrideFromQuery', false)
        })
      )
    }

    this.use(maintenancePlugin(this.app.make('maintenance'), this.config('session.path', '/')))

    // Its own plugin, and registered before the session check: deferred work has
    // nothing to do with sessions, and an API with sessions turned off still
    // expects `defer()` to run.
    this.use(this.deferPlugin())

    // Before sessions and CSRF: a preflight carries no cookies and must be
    // answered even when the request that follows it would be refused.
    const cors = corsConfig(this.config<Partial<CorsConfig>>('cors', {}))
    const overrides = this.config<CorsOverride[]>('cors.overrides', [])

    if (cors.paths.length > 0 || overrides.length > 0) {
      this.use(this.corsPlugin(cors, overrides))
    }

    const sessionName = this.config<string>('session.cookie', 'elvel_session')

    /**
     * No key, no sessions — and no crash either.
     *
     * The session cookie is signed with `APP_KEY`, so an application without one
     * cannot have sessions. It used to throw here, which meant the whole
     * application refused to boot, which meant `elvel key:generate` refused to
     * run: the command that sets the key needed the key. That was invisible while
     * the template shipped a placeholder key, and turned up the moment it shipped
     * an empty one.
     *
     * Skipped with a warning instead. Anything that actually needs a session
     * still fails, and the command that fixes it can run.
     */
    const signingKeySet = this.config<string>('app.key', '') !== ''

    if (this.config<SecurityConfig>('security', {}).enabled !== false) {
      this.use(this.securityPlugin())
    }

    if (this.config<boolean>('session.enabled', true) !== false && signingKeySet) {
      this.use(await this.sessionPlugin())
    } else if (!signingKeySet) {
      console.warn('[http] APP_KEY is not set, so sessions are off. Run: elvel key:generate')
    }

    /**
     * After the session plugin, because both write `Set-Cookie` and this one
     * appends to what is already there.
     *
     * The session cookie is always excepted: it is signed by the plugin above, and
     * encrypting it a second time here would leave a value neither half can read.
     */
    /**
     * A name that points at no route is a boot failure, not a 404 later.
     *
     * Read from Elysia's own table, after every controller has mounted, so it
     * sees what was actually registered rather than what was meant to be.
     */
    this.app.booted(() => {
      const router = (this.app as unknown as { router?: { routes?: Array<{ path: string }> } })
        .router

      if (router?.routes) this.app.make('routes').verify(router.routes)
    })

    // Same reason as the session plugin: the jar signs with `APP_KEY`, and
    // resolving it here would stop `key:generate` from ever running.
    if (signingKeySet) {
      this.use(
        cookiePlugin(this.app.make('cookies'), {
          except: [sessionName, ...this.config<string[]>('cookies.except', [])]
        })
      )
    }
  }

  /**
   * Answer preflights, and add the headers to everything else on a matching path.
   *
   * A refused origin gets a normal response with no CORS headers rather than a
   * 403: the browser is what turns the absence into an error, and a 403 would
   * break same-origin callers of the same route.
   */
  private corsPlugin(global: CorsConfig, overrides: CorsOverride[] = []) {
    return new Elysia({ name: 'elvel:cors' })
      .onRequest(({ request, set }) => {
        const config = corsFor(request, global, overrides)

        if (!pathMatches(config, request)) return undefined
        if (!isPreflight(request)) return undefined

        // 204 and nothing else: a preflight never reaches a route, so it is not
        // subject to CSRF, sessions, or the handler's own rules.
        for (const [header, value] of Object.entries(preflightHeaders(config, request))) {
          set.headers[header] = value
        }

        return new Response(null, { status: 204, headers: set.headers as HeadersInit })
      })
      .onAfterHandle({ as: 'global' }, ({ request, set }) => {
        const config = corsFor(request, global, overrides)

        if (!pathMatches(config, request)) return

        for (const [header, value] of Object.entries(actualHeaders(config, request))) {
          set.headers[header] = value
        }
      })
  }

  /**
   * Flush deferred callbacks once the response is out, so the client waits for
   * none of it.
   *
   * Registered here because this package owns the request lifecycle; `defer()`
   * itself is a core primitive with no idea that HTTP exists.
   */
  private deferPlugin() {
    return new Elysia({ name: 'elvel:defer' }).onAfterResponse({ as: 'global' }, async () => {
      await flushDeferred((error) => this.app.make('exception.handler').report(error))
    })
  }

  /**
   * Start a session per request, verify CSRF, then persist and set the cookie.
   *
   * The cookie carries only a signed id: the data itself never leaves the
   * server, which is why signing is enough and encryption is not needed here.
   */
  /**
   * This response's CSP nonce, generated once and read twice.
   *
   * The policy header has to name it and the view has to render it, and those are
   * two different moments in the same request — so it cannot be generated by
   * either one of them. Keyed by the `Request`, like the session.
   */
  private readonly nonces = new WeakMap<Request, string>()

  private nonceFor(request: Request): string | undefined {
    if (this.config<SecurityConfig>('security', {}).csp === false) return undefined

    const already = this.nonces.get(request)

    if (already !== undefined) return already

    const nonce = newNonce()

    this.nonces.set(request, nonce)

    return nonce
  }

  /**
   * The security headers, on both paths a response can leave by.
   *
   * `mapResponse` covers the handler path and nothing else — measured: an
   * unmatched path and a static file both came back without a header set there.
   * So the error path is served by `request.lifecycle`, which exists because every
   * per-request hook belongs to a handler and an error response has none.
   *
   * What is still not covered is a file the static plugin answers: it claims its
   * own route and skips the outer lifecycle entirely. A stylesheet is a smaller
   * problem than a document, and closing it means moving those responses through
   * something that can see them — recorded rather than half-done.
   */
  private securityPlugin() {
    const config = this.config<SecurityConfig>('security', {})
    /**
     * Named for what it decides, not for what it reads.
     *
     * There were two `const secure = this.app.isProduction()` in this file — this
     * one, which sends HSTS, and the session cookie's `Secure` attribute — and a
     * config read meant for the cookie landed here instead. Same expression, same
     * name, thirty lines apart, and no test could tell them apart because neither
     * set the new key. Two different questions get two different names.
     */
    const overHttps = this.app.isProduction()
    const hot = this.app.publicPath('hot')

    /**
     * The dev server's origin, read per response while one is running.
     *
     * A file read on every response is a cost worth naming, and it is only paid
     * where the file exists — development. The alternative was reading it once at
     * boot, which is before `elvel dev` has started Vite, so the policy would have
     * blocked every module in exactly the session it was meant to help.
     */
    const devOrigin = (): string | undefined => {
      if (overHttps || !existsSync(hot)) return undefined

      const origin = readFileSync(hot, 'utf8').trim()

      return origin === '' ? undefined : origin
    }

    const headersFor = (request: Request) =>
      securityHeaders(config, {
        secure: overHttps,
        nonce: this.nonces.get(request),
        devOrigin: devOrigin()
      })

    if (this.app.bound('request.lifecycle')) {
      this.app.make('request.lifecycle').finishing((request, response) => {
        for (const [name, value] of Object.entries(headersFor(request))) {
          if (!response.headers.has(name)) response.headers.set(name, value)
        }
      })
    }

    /**
     * Bound, so a package that answers its own responses can add them.
     *
     * `@elvel/view` serves static files itself, and those responses come from a
     * plugin whose routes skip the surrounding lifecycle — so a header set here
     * cannot reach them. It reads this instead, through the container, because
     * `view` does not depend on `http` and should not have to.
     */
    this.app.instance('security.headers', headersFor)

    return new Elysia({ name: 'elvel:security' }).mapResponse(
      { as: 'global' },
      ({ request, set }) => {
        for (const [name, value] of Object.entries(headersFor(request))) {
          set.headers[name] ??= value
        }

        // Nothing is being mapped: the body stays whatever the handler answered.
        return undefined
      }
    )
  }

  private async sessionPlugin() {
    /**
     * This request's session, held until the scope is entered.
     *
     * Keyed by the `Request` so nothing has to be added to the context, and so a
     * finished request's session is collectable. Read by the restorer below, on
     * the one path that has no handler to enter the scope for it.
     */
    const sessions = new WeakMap<Request, Session>()

    const driver = this.app.make('session.driver')
    const jar = this.app.make('cookies')
    const name = this.config<string>('session.cookie', 'elvel_session')
    const lifetime = this.config<number>('session.lifetime', 7200)

    /**
     * `Lax` by default, `Strict` where it costs nothing.
     *
     * `Lax` attaches the cookie to a top-level navigation from another site, which
     * is what makes a link from an email land signed in. `Strict` refuses even
     * that: safer, and a visible difference to anybody arriving by link, so it is
     * a choice rather than a default.
     */
    const sameSite = this.config<'lax' | 'strict' | 'none'>('session.sameSite', 'lax')
    const except = this.config<string[]>('session.csrfExcept', [])
    const csrfEnabled = this.config<boolean>('session.csrf', true)

    /**
     * Over TLS only, in production.
     *
     * Configurable because a development setup can be HTTPS and a production one
     * can sit behind a proxy that terminates it — but the default is the safe half
     * of that: a cookie sent over plain HTTP in production is a cookie on the wire.
     */
    const secureCookie = this.config<boolean>('session.secure', this.app.isProduction())

    /**
     * Encrypt the session cookie, when asked and when an encrypter exists.
     *
     * Signing is enough for what the cookie holds — an opaque id — so this is off
     * by default; it is here because an encrypted cookie also hides the id from
     * anything reading the browser's storage.
     */
    const encryptionAsked = this.config<boolean>('session.encrypt', false)
    const encryptSession = encryptionAsked && jar.encrypts

    // Asked for and not possible is worth saying out loud: falling back to signing
    // silently would leave someone believing the cookie is encrypted when it is not.
    if (encryptionAsked && !jar.encrypts) {
      const message =
        'session.encrypt is on but no encrypter is bound, so the session cookie is only signed. Register EncryptionServiceProvider.'

      if (this.app.bound('log')) {
        ;(this.app.make('log' as never) as { warning(text: string): void }).warning(message)
      } else {
        console.warn(message)
      }
    }

    /**
     * The whole session lifecycle, for a response with no handler.
     *
     * `derive`, `onBeforeHandle` and `onAfterHandle` all belong to a handler, and
     * an error response has none — nothing matched, or something threw first. So
     * before this existed a document rendered by the 404 handler carried
     * `csrf: ''` **and** came back with no `Set-Cookie` at all: measured, an
     * unmatched request set no cookie while a matched one did. The client booted
     * with a token for a session nobody stored, and the first write it attempted
     * was refused with 419 — silent until then, which is what made it worth
     * fixing rather than writing down.
     *
     * Three steps because the work has three shapes: read the session (async),
     * enter its scope (must be synchronous), then save it and re-issue the cookie
     * (async, and only once the response exists).
     */
    if (this.app.bound('request.lifecycle')) {
      this.app
        .make('request.lifecycle')
        .preparing(async (request) => {
          await sessionFor(request)
        })
        .entering((request) => {
          const session = sessions.get(request)

          if (session !== undefined)
            enterRequestScope({ request, session, nonce: this.nonceFor(request) })
        })
        .finishing(async (request, response) => {
          const session = sessions.get(request)

          if (session === undefined) return

          /**
           * Nothing more to do if something already saved it.
           *
           * A redirect built with flash data persists the session itself, and
           * `save()` *ages* the flash — it drops what the last request flashed and
           * promotes what this one did. So a second save here throws away the
           * message that first save had just promoted, and the page meant to show
           * it renders empty. The cookie below is still worth re-issuing.
           */
          if (!session.isPersisted()) {
            /**
             * Where `back()` goes next — recorded only for a session that already
             * has something in it.
             *
             * Recording it unconditionally is what this used to do, and it made
             * every `GET` dirty, which saved a session for every visitor to every
             * page. Together with a token minted at `start()` that meant a
             * first-time visitor to a page with no form on it wrote a session file
             * and left with a cookie — 323 requests a second against 1,100, and a
             * `Set-Cookie` on a document built to be cached by a CDN.
             *
             * Tying it to `isDirty()` costs nothing real: `back()` matters after a
             * form is refused, and a page with a form has already asked for a CSRF
             * token, which is what makes its session dirty. A page that asked for
             * nothing is not a page anybody is sent back to.
             *
             * Still not recorded for a 404 or a 500 — a page nobody can return to
             * is not worth remembering — nor for a cross-origin request.
             */
            if (
              session.isDirty() &&
              request.method === 'GET' &&
              !isCorsRequest(request) &&
              response.status < 400
            ) {
              session.put(
                PREVIOUS_URL_KEY,
                new URL(request.url).pathname + new URL(request.url).search
              )
            }

            /**
             * And saved only if there is something to save.
             *
             * Ageing the flash of a session nobody touched consumes a message on
             * its way to a page. Measured as four smoke failures when this saved
             * unconditionally: a `419` for a missing CSRF token ate the flash a
             * successful write had just set, and a browser asking for a favicon
             * that does not exist would have done the same.
             */
            if (session.isDirty()) await session.save()
          }

          /**
           * No cookie for a session with nothing in it.
           *
           * The cookie is what makes a response uncacheable by anything shared, and
           * handing one out for a session that was never written names an id the
           * next request would find empty anyway. The moment anything real happens —
           * a token, a flash, signing in — the session is dirty and the cookie goes.
           */
          if (
            session.isDirty() ||
            session.isPersisted() ||
            session.hasFlashData() ||
            session.wasStored()
          ) {
            response.headers.append('set-cookie', cookieFor(session))
          }
        })
    }

    /**
     * This request's session, resolved once.
     *
     * Two callers now — the `derive` below, and the error path through
     * `request.lifecycle` — and they must not each start their own: two `Session`
     * objects for one request means one of them saves over the other.
     */
    const sessionFor = async (request: Request): Promise<Session> => {
      const already = sessions.get(request)

      if (already !== undefined) return already

      const cookies = CookieJar.parse(request.headers.get('cookie'))

      // Encrypted when configured and possible; signed otherwise. Reading falls
      // back to the other form so a running application survives the switch
      // without logging everyone out.
      const id =
        (encryptSession ? jar.decrypt(name, cookies[name]) : undefined) ??
        jar.unsign(cookies[name]) ??
        Session.newId()

      const session = await new Session(id, driver, name).start()

      sessions.set(request, session)

      return session
    }

    /**
     * Re-issued on every response, which is what keeps its lifetime rolling.
     *
     * `httpOnly` is not configurable, and that is the point: a session cookie a
     * script can read is a session an injected script can steal, and there is no
     * application for which that is the right trade. Everything else here is.
     */
    const cookieFor = (session: Session): string =>
      CookieJar.serialize(
        name,
        encryptSession ? jar.encrypt(name, session.id) : jar.sign(session.id),
        { maxAge: lifetime, httpOnly: true, secure: secureCookie, sameSite }
      )

    return (
      new Elysia({ name: 'elvel:session' })
        .derive({ as: 'global' }, async ({ request }) => ({
          session: await sessionFor(request)
        }))
        /**
         * Enter the request scope, **synchronously**.
         *
         * This is what makes `errors()` and `old()` work inside a JSX component with
         * no props threaded through. It cannot move into the async `derive` above:
         * `enterWith` applies to the rest of the current execution, and an `await`
         * restores the frame its continuation was scheduled with — so the scope would
         * be gone by the time a handler runs. There is a test for the arrangement,
         * because it depends on Elysia not emitting an `await` for a sync hook.
         */
        .onBeforeHandle({ as: 'global' }, ({ request, session }) => {
          enterRequestScope({ request, session, nonce: this.nonceFor(request) })
        })
        /**
         * CSRF is checked in `transform`, which runs **before** validation.
         *
         * A route that declares a body schema has its body stripped of anything
         * the schema does not mention, and `_token` is exactly that — so a form
         * posting to a validated route failed with 419 while an identical form
         * posting to an unvalidated one succeeded. Found by scaffolding the auth
         * starter kit, which validates every form it posts.
         */
        .onTransform({ as: 'global' }, async ({ request, session, body }) => {
          if (!csrfEnabled) return

          const headers: Record<string, string | undefined> = {}
          request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value
          })

          const path = new URL(request.url).pathname

          if (!tokensMatch(session, { method: request.method, path, body, headers, except })) {
            throw new TokenMismatchError()
          }
        })
        .onAfterHandle({ as: 'global' }, async ({ request, session, set }) => {
          /**
           * A session nobody touched is left alone — not recorded, not written, and
           * not given a cookie.
           *
           * This ran unconditionally, and it is what made every visitor cost a
           * write. The `put` below marks the session changed, so the `save` always
           * had something to do, so every response carried a `Set-Cookie` — on a
           * page with no form, for a visitor who was never going to come back.
           * Measured at fifty concurrent callers: 323 requests a second against
           * 1,100 once a cookie existed, and a document built to be cached by a CDN
           * that no shared cache would ever store.
           *
           * Flash data is the exception that has to be checked, not assumed. Ageing
           * happens *inside* `save()`, so a session holding a message and skipped
           * here would show that message again on the next request.
           */
          const worthWriting = session.isDirty() || session.hasFlashData()

          if (worthWriting) {
            /**
             * Remember where this request was, so the *next* one can go `back()`.
             *
             * Only for a page a browser can return to: recording a POST would send
             * `back()` to a URL that only answers a form submission, and recording
             * an asset or an API call would send it somewhere nobody was looking at.
             *
             * And only for a session that already has something in it. `back()`
             * matters after a form is refused, and a page with a form has asked for
             * a CSRF token — which is what made its session worth writing.
             */
            if (request.method === 'GET' && !isCorsRequest(request)) {
              session.put(
                PREVIOUS_URL_KEY,
                new URL(request.url).pathname + new URL(request.url).search
              )
            }

            await session.save()
          }

          /**
           * The cookie goes to anybody who has a session, not only to a request that
           * wrote one.
           *
           * Re-issuing it refreshes `Max-Age`, so reading pages for an hour does not
           * end with being logged out. What is left out is the case this is all for:
           * a visitor with no session, on a page that did not give them one.
           */
          if (worthWriting || session.wasStored()) {
            set.headers['set-cookie'] = cookieFor(session)
          }
        })
    )
  }
}
