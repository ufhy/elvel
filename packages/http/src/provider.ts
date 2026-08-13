import { join } from 'node:path'
import { flushDeferred, ServiceProvider } from '@elysian/core'
import { Elysia } from 'elysia'
import { MakeRequestCommand } from './console/make-request.ts'
import { MakeResourceCommand } from './console/make-resource.ts'
import { SessionTableCommand } from './console/session-table.ts'
import { cookiePlugin } from './cookie-plugin.ts'
import { CookieJar } from './cookies.ts'
import {
  actualHeaders,
  type CorsConfig,
  corsConfig,
  isCorsRequest,
  isPreflight,
  pathMatches,
  preflightHeaders
} from './cors.ts'
import { TokenMismatchError, tokensMatch } from './csrf.ts'
import { maintenancePlugin } from './maintenance.ts'
import { PREVIOUS_URL_KEY } from './redirect.ts'
import { RouteRegistry } from './routes.ts'
import { enterRequestScope } from './scope.ts'
import { FileSessionDriver, MemorySessionDriver, Session, type SessionDriver } from './session.ts'
import { CacheSessionDriver, DatabaseSessionDriver } from './session-drivers.ts'
import { LimiterRegistry } from './throttle.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    'session.driver': SessionDriver
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
  register(): void {
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
            'The database session driver needs DatabaseServiceProvider. Register it, then run: artisan session:table && artisan migrate'
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
    if (this.app.bound('artisan')) {
      this.app
        .make('artisan')
        .register(MakeRequestCommand, MakeResourceCommand, SessionTableCommand)
    }

    /**
     * First, before anything else: an application that is down should not be
     * starting sessions, checking CSRF or counting rate limits for requests it is
     * about to refuse.
     */
    this.use(maintenancePlugin(this.app.make('maintenance'), this.config('session.path', '/')))

    // Its own plugin, and registered before the session check: deferred work has
    // nothing to do with sessions, and an API with sessions turned off still
    // expects `defer()` to run.
    this.use(this.deferPlugin())

    // Before sessions and CSRF: a preflight carries no cookies and must be
    // answered even when the request that follows it would be refused.
    const cors = corsConfig(this.config<Partial<CorsConfig>>('cors', {}))
    if (cors.paths.length > 0) this.use(this.corsPlugin(cors))

    const sessionName = this.config<string>('session.cookie', 'elysian_session')

    if (this.config<boolean>('session.enabled', true) !== false) {
      this.use(await this.sessionPlugin())
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

    this.use(
      cookiePlugin(this.app.make('cookies'), {
        except: [sessionName, ...this.config<string[]>('cookies.except', [])]
      })
    )
  }

  /**
   * Answer preflights, and add the headers to everything else on a matching path.
   *
   * A refused origin gets a normal response with no CORS headers rather than a
   * 403: the browser is what turns the absence into an error, and a 403 would
   * break same-origin callers of the same route.
   */
  private corsPlugin(config: CorsConfig) {
    return new Elysia({ name: 'elysian:cors' })
      .onRequest(({ request, set }) => {
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
    return new Elysia({ name: 'elysian:defer' }).onAfterResponse({ as: 'global' }, async () => {
      await flushDeferred((error) => this.app.make('exception.handler').report(error))
    })
  }

  /**
   * Start a session per request, verify CSRF, then persist and set the cookie.
   *
   * The cookie carries only a signed id: the data itself never leaves the
   * server, which is why signing is enough and encryption is not needed here.
   */
  private async sessionPlugin() {
    const driver = this.app.make('session.driver')
    const jar = this.app.make('cookies')
    const name = this.config<string>('session.cookie', 'elysian_session')
    const lifetime = this.config<number>('session.lifetime', 7200)
    const except = this.config<string[]>('session.csrfExcept', [])
    const csrfEnabled = this.config<boolean>('session.csrf', true)
    const secure = this.app.isProduction()

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

    return (
      new Elysia({ name: 'elysian:session' })
        .derive({ as: 'global' }, async ({ request }) => {
          const cookies = CookieJar.parse(request.headers.get('cookie'))

          // Encrypted when configured and possible; signed otherwise. Reading falls
          // back to the other form so a running application survives the switch
          // without logging everyone out.
          const id =
            (encryptSession ? jar.decrypt(name, cookies[name]) : undefined) ??
            jar.unsign(cookies[name]) ??
            Session.newId()

          const session = await new Session(id, driver, name).start()

          return { session }
        })
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
          enterRequestScope({ request, session })
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
           * Remember where this request was, so the *next* one can go `back()`.
           *
           * Only for a page a browser can return to: recording a POST would send
           * `back()` to a URL that only answers a form submission, and recording an
           * asset or an API call would send it somewhere nobody was looking at.
           */
          if (request.method === 'GET' && !isCorsRequest(request)) {
            session.put(
              PREVIOUS_URL_KEY,
              new URL(request.url).pathname + new URL(request.url).search
            )
          }

          await session.save()

          // Re-issuing every response keeps the cookie's lifetime rolling.
          const value = encryptSession ? jar.encrypt(name, session.id) : jar.sign(session.id)

          set.headers['set-cookie'] = CookieJar.serialize(name, value, {
            maxAge: lifetime,
            httpOnly: true,
            secure,
            sameSite: 'lax'
          })
        })
    )
  }
}
