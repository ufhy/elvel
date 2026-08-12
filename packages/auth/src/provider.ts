import { ServiceProvider } from '@elysian/core'
import { betterAuth } from 'better-auth'
import { Elysia } from 'elysia'
import { type Dialect, elysianAdapter } from './adapter.ts'
import { AuthSchemaCommand } from './console/auth-schema.ts'
import { MakePolicyCommand } from './console/make-policy.ts'
import { Gate } from './gate.ts'
import { type AuthInstance, AuthManager } from './manager.ts'

declare module '@elysian/contracts' {
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
  register(): void {
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
    if (this.app.bound('artisan')) {
      this.app.make('artisan').register(AuthSchemaCommand, MakePolicyCommand)
    }

    const auth = await this.instance()
    const manager = new AuthManager(auth)

    this.app.instance('auth', manager)

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
    const { connection, mount, basePath, ...options } = config

    const db = this.app.make('db')
    const dialect = (await db.connection(connection)).grammar.dialect as Dialect

    return betterAuth({
      ...options,
      basePath: basePath ?? '/api/auth',
      database: elysianAdapter(db, { connection, dialect })
    }) as unknown as AuthInstance
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

    const plugin = new Elysia({ name: 'elysian:auth' })
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
        manager.enterScope(manager.recall(request))
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
