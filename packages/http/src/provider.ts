import { join } from 'node:path'
import { ServiceProvider } from '@elysian/core'
import { Elysia } from 'elysia'
import { MakeRequestCommand } from './console/make-request.ts'
import { MakeResourceCommand } from './console/make-resource.ts'
import { CookieJar } from './cookies.ts'
import { TokenMismatchError, tokensMatch } from './csrf.ts'
import { FileSessionDriver, MemorySessionDriver, Session, type SessionDriver } from './session.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    'session.driver': SessionDriver
    cookies: CookieJar
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

      throw new Error(`Session driver [${driver}] is not supported.`)
    })

    this.app.singleton('cookies', () => {
      const key = this.config<string>('app.key', '')

      if (key === '') {
        throw new Error('Set APP_KEY (32+ characters) before using signed cookies or sessions.')
      }

      return new CookieJar(key)
    })
  }

  override async boot(): Promise<void> {
    if (this.app.bound('artisan')) {
      this.app.make('artisan').register(MakeRequestCommand, MakeResourceCommand)
    }

    if (this.config<boolean>('session.enabled', true) === false) return

    this.use(await this.sessionPlugin())
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

    return new Elysia({ name: 'elysian:session' })
      .derive({ as: 'global' }, async ({ request }) => {
        const cookies = CookieJar.parse(request.headers.get('cookie'))
        const id = jar.unsign(cookies[name]) ?? Session.newId()

        const session = await new Session(id, driver, name).start()

        return { session }
      })
      .onBeforeHandle({ as: 'global' }, async ({ request, session, body }) => {
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
      .onAfterHandle({ as: 'global' }, async ({ session, set }) => {
        await session.save()

        // Re-issuing every response keeps the cookie's lifetime rolling.
        set.headers['set-cookie'] = CookieJar.serialize(name, jar.sign(session.id), {
          maxAge: lifetime,
          httpOnly: true,
          secure,
          sameSite: 'lax'
        })
      })
  }
}
