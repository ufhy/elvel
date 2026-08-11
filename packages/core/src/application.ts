import { join, resolve } from 'node:path'
import type {
  AppEnvironment,
  ApplicationContract,
  BindingKey,
  ExceptionHandlerContract,
  Factory,
  Resolved,
  ServiceProviderConstructor,
  ServiceProviderContract
} from '@elysian/contracts'
import { Elysia } from 'elysia'
import { Config } from './config.ts'
import { Env } from './env.ts'
import { ExceptionHandler } from './exceptions.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    'exception.handler': ExceptionHandlerContract
  }
}

type Binding = {
  factory: Factory<unknown>
  shared: boolean
}

/** A route module: an Elysia plugin, or a factory that builds one. */
export type RouteModule =
  | Elysia<any, any, any, any, any, any>
  | ((app: Application) => Elysia<any, any, any, any, any, any>)

export type RouteLoader = () => Promise<{ default: RouteModule }>

/**
 * Application — container, provider registry, and owner of the root Elysia
 * instance.
 *
 * The bootstrap order mirrors `Illuminate\Foundation\Http\Kernel`:
 * env -> config -> exceptions -> register providers -> boot providers.
 */
export class Application implements ApplicationContract {
  private static current?: Application

  private readonly bindings = new Map<string, Binding>()
  private readonly resolvedInstances = new Map<string, unknown>()
  private readonly providers: ServiceProviderContract[] = []
  private readonly bootedCallbacks: Array<(app: ApplicationContract) => void | Promise<void>> = []
  private isBooted = false

  readonly router: Elysia
  config: Config

  constructor(private readonly root: string) {
    this.config = new Config()
    this.router = new Elysia({ name: 'elysian' })

    this.instance('exception.handler', new ExceptionHandler(this))
    Application.current = this
  }

  static configure(basePath: string): ApplicationBuilder {
    return new ApplicationBuilder(resolve(basePath))
  }

  /**
   * The running application. Backs the global helpers (`config()`, `view()`),
   * the same role `Illuminate\Container\Container::getInstance()` plays.
   */
  static getInstance(): Application {
    if (!Application.current) {
      throw new Error(
        'No application instance. Boot one with Application.configure(basePath).create() first.'
      )
    }
    return Application.current
  }

  static setInstance(app: Application | undefined): void {
    Application.current = app
  }

  // ---------------------------------------------------------------- container

  bind<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    this.bindings.set(key as string, { factory: factory as Factory<unknown>, shared: false })
    this.resolvedInstances.delete(key as string)
    return this
  }

  singleton<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    this.bindings.set(key as string, { factory: factory as Factory<unknown>, shared: true })
    this.resolvedInstances.delete(key as string)
    return this
  }

  instance<K extends BindingKey>(key: K, value: Resolved<K>): this {
    this.resolvedInstances.set(key as string, value)
    return this
  }

  make<K extends BindingKey>(key: K): Resolved<K> {
    const name = key as string

    if (this.resolvedInstances.has(name)) {
      return this.resolvedInstances.get(name) as Resolved<K>
    }

    const binding = this.bindings.get(name)
    if (!binding) {
      throw new Error(`Target [${name}] is not bound in the container.`)
    }

    const value = binding.factory(this)
    if (binding.shared) this.resolvedInstances.set(name, value)

    return value as Resolved<K>
  }

  bound(key: BindingKey): boolean {
    return this.bindings.has(key as string) || this.resolvedInstances.has(key as string)
  }

  // -------------------------------------------------------------------- paths

  basePath(...segments: string[]): string {
    return join(this.root, ...segments)
  }

  configPath(...segments: string[]): string {
    return this.basePath('config', ...segments)
  }

  appPath(...segments: string[]): string {
    return this.basePath('app', ...segments)
  }

  resourcePath(...segments: string[]): string {
    return this.basePath('resources', ...segments)
  }

  viewPath(...segments: string[]): string {
    return this.resourcePath('views', ...segments)
  }

  routesPath(...segments: string[]): string {
    return this.basePath('routes', ...segments)
  }

  publicPath(...segments: string[]): string {
    return this.basePath('public', ...segments)
  }

  storagePath(...segments: string[]): string {
    return this.basePath('storage', ...segments)
  }

  // -------------------------------------------------------------- environment

  environment(): AppEnvironment {
    return this.config.get<AppEnvironment>('app.env', Env.string('APP_ENV', 'production'))
  }

  isProduction(): boolean {
    return this.environment() === 'production'
  }

  isLocal(): boolean {
    return this.environment() === 'local'
  }

  hasDebugModeEnabled(): boolean {
    return this.config.get<boolean>('app.debug', false) === true
  }

  // ---------------------------------------------------------------- providers

  async register(provider: ServiceProviderConstructor): Promise<this> {
    const instance = new provider(this)
    this.providers.push(instance)
    await instance.register()

    // Registered after the app already booted (e.g. a test helper) — boot now
    // so the provider is never left half-initialised.
    if (this.isBooted) await instance.boot?.()

    return this
  }

  async boot(): Promise<this> {
    if (this.isBooted) return this

    for (const provider of this.providers) {
      await provider.boot?.()
    }

    this.isBooted = true

    for (const callback of this.bootedCallbacks) {
      await callback(this)
    }
    this.bootedCallbacks.length = 0

    return this
  }

  booted(callback: (app: ApplicationContract) => void | Promise<void>): this {
    if (this.isBooted) {
      void callback(this)
    } else {
      this.bootedCallbacks.push(callback)
    }
    return this
  }

  // ------------------------------------------------------------------ routing

  /** Mount a route module (an Elysia plugin) onto the root router. */
  useRoutes(module: RouteModule): this {
    const plugin = typeof module === 'function' ? module(this) : module
    this.router.use(plugin as never)
    return this
  }

  /** Wire the exception handler into Elysia's error pipeline. */
  handleExceptions(): this {
    const handler = this.make('exception.handler')

    this.router.onError(({ error, request }) => {
      void handler.report(error)
      return handler.render(error, { request })
    })

    return this
  }

  // -------------------------------------------------------------------- serve

  async listen(port?: number, hostname?: string): Promise<Application> {
    const resolvedPort = port ?? this.config.get<number>('app.port', Env.number('PORT', 3000))
    const resolvedHost = hostname ?? this.config.get<string>('app.host', Env.string('HOST', ''))

    this.router.listen(
      resolvedHost === '' ? resolvedPort : { port: resolvedPort, hostname: resolvedHost }
    )

    return this
  }

  handle(request: Request): Promise<Response> {
    return this.router.handle(request)
  }

  get url(): string {
    return this.config.get<string>('app.url', 'http://localhost:3000')
  }
}

/**
 * Fluent bootstrapper, mirroring Laravel 11+'s
 * `Application::configure(...)->withProviders(...)->create()`.
 */
export class ApplicationBuilder {
  private readonly providers: ServiceProviderConstructor[] = []
  private readonly routeLoaders: RouteLoader[] = []

  constructor(private readonly basePath: string) {}

  withProviders(providers: ServiceProviderConstructor[]): this {
    this.providers.push(...providers)
    return this
  }

  /**
   * Register a route file. Pass a lazy import so route modules load after the
   * container is populated:
   *
   * ```ts
   * .withRoutes(() => import('../routes/web.ts'))
   * ```
   */
  withRoutes(...loaders: RouteLoader[]): this {
    this.routeLoaders.push(...loaders)
    return this
  }

  async create(): Promise<Application> {
    const app = new Application(this.basePath)

    // 1. env
    await Env.load(this.basePath, Env.string('APP_ENV', ''))

    // 2. config
    app.config = await Config.loadFrom(app.configPath())

    // 3. exceptions
    app.handleExceptions()

    // 4. register providers — framework providers from config first, then the
    //    application's own, so app providers can override framework bindings.
    const configured = app.config.get<ServiceProviderConstructor[]>('app.providers', [])
    for (const provider of [...configured, ...this.providers]) {
      await app.register(provider)
    }

    // 5. boot providers
    await app.boot()

    // 6. routes — last, so handlers can resolve anything a provider bound
    for (const loader of this.routeLoaders) {
      const module = await loader()
      app.useRoutes(module.default)
    }

    return app
  }
}
