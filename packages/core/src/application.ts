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
} from '@elvel/contracts'
import { reportRescuedUsing, useLocale } from '@elvel/support'
import { Elysia } from 'elysia'
import { Config } from './config.ts'
import { Env } from './env.ts'
import { ExceptionHandler } from './exceptions.ts'
import { RequestLifecycle } from './lifecycle.ts'
import { MaintenanceMode } from './maintenance.ts'
import { PortInUseError, portInUse, portInUseMessage } from './port.ts'
import { inRequestContext, requestSlot } from './request-context.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    'exception.handler': ExceptionHandlerContract
    maintenance: MaintenanceMode
    'request.lifecycle': RequestLifecycle
  }
}

type Binding = {
  factory: Factory<unknown>
  shared: boolean
  /** Shared, but only for the duration of one request. */
  scoped?: boolean
}

/** A callback that sees a value on its way out of the container. */
type ResolutionHook = (value: unknown, app: ApplicationContract) => void

/** A callback that sees a key on its way in. */
type ResolvingHook = (key: string, app: ApplicationContract) => void

/** Anything asked for by no key in particular. */
const ANY = '*'

/** Scoped instances for the request that is running. */
const scopedSlot = requestSlot<Map<string, unknown>>('container.scoped')

/** What `when(...)` returns, so `needs().give()` reads as one sentence. */
export type ContextualBuilder = {
  needs(key: BindingKey): { give(implementation: Factory<unknown> | unknown): Application }
}

/** A route module: an Elysia plugin, or a factory that builds one. */
export type RouteModule =
  | Elysia<any, any, any, any, any, any>
  | ((app: Application) => Elysia<any, any, any, any, any, any>)

/**
 * A routes file: `() => import('../routes/web.ts')`.
 *
 * `default` is optional because a routes file usually exports nothing —
 * `Route.get(…)` declares as the module evaluates, and the framework compiles the
 * collection afterwards. A module that does export a plugin is mounted directly,
 * so a package shipping one needs no rewriting.
 */
export type RouteLoader = () => Promise<{ default?: RouteModule }>

/**
 * What `withMiddleware` hands over.
 *
 * Structural rather than the registry's own type: the registry lives in
 * `@elvel/http` and this file is `@elvel/core`, and the dependency runs one way.
 */
export type MiddlewareConfigurator = {
  alias(name: string, factory: (...args: string[]) => unknown): unknown
  group(name: string, names: string[]): unknown
  priority(names: string[]): unknown
  /** Mount a plugin after the framework's own stack. */
  append(plugin: RouteModule): void
}

/** What `withExceptions` hands over — the bound handler, narrowed to its rules. */
export type ExceptionRules = {
  dontReport(...types: Array<new (...args: any[]) => Error>): unknown
  stopIgnoring(...types: Array<new (...args: any[]) => Error>): unknown
  reportable(callback: (error: unknown) => boolean | undefined): unknown
  renderUsing(
    type: new (...args: any[]) => Error,
    render: (error: never, request: Request) => Response | undefined
  ): unknown
  renderable(render: (error: unknown, request: Request) => Response | undefined): unknown
}

/** `{ app: () => import('../config/app.ts') }` — see `withConfig`. */
export type ConfigLoaders = Record<string, () => Promise<{ default?: unknown }>>

/**
 * Application — container, provider registry, and owner of the root Elysia
 * instance.
 *
 * The bootstrap order:
 * env -> config -> exceptions -> register providers -> boot providers.
 */
export class Application implements ApplicationContract {
  private static current?: Application

  private readonly bindings = new Map<string, Binding>()
  private readonly resolvedInstances = new Map<string, unknown>()
  private readonly resolvedKeys = new Set<string>()
  private readonly extenders = new Map<
    string,
    Array<(value: unknown, app: ApplicationContract) => unknown>
  >()
  private readonly rebindingHooks = new Map<string, ResolutionHook[]>()
  private readonly beforeHooks = new Map<string, ResolutionHook[]>()
  private readonly resolvingHooks = new Map<string, ResolutionHook[]>()
  private readonly afterHooks = new Map<string, ResolutionHook[]>()
  private readonly tagged_ = new Map<string, string[]>()
  private readonly contextual = new Map<string, Map<string, Factory<unknown>>>()
  private readonly scopedOutsideRequest = new Map<string, unknown>()

  /** The stack of keys currently being built — what makes `when()` work. */
  private readonly building: string[] = []
  private readonly providers: ServiceProviderContract[] = []
  private readonly terminatingCallbacks: Array<(app: ApplicationContract) => void | Promise<void>> =
    []

  private listeningForShutdown = false

  private readonly bootedCallbacks: Array<(app: ApplicationContract) => void | Promise<void>> = []
  private isBooted = false

  readonly router: Elysia
  config: Config

  constructor(private readonly root: string) {
    this.config = new Config()
    this.router = new Elysia({ name: 'elvel' })

    this.instance('exception.handler', new ExceptionHandler(this))

    /**
     * Bound here, not in a provider, because the error path uses it and the error
     * path has to work before and after any provider has a say.
     */
    this.instance('request.lifecycle', new RequestLifecycle())

    // Bound in the constructor rather than a provider: `elvel down` has to work
    // when a provider cannot boot, which is one of the reasons to run it.
    this.instance('maintenance', new MaintenanceMode(this.storagePath('framework', 'down')))

    Application.current = this
  }

  static configure(basePath: string): ApplicationBuilder {
    return new ApplicationBuilder(resolve(basePath))
  }

  /**
   * The running application. Backs the global helpers (`config()`, `view()`),
   * the role a container's own static instance plays.
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
    return this.record(key, factory, { shared: false })
  }

  singleton<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    return this.record(key, factory, { shared: true })
  }

  /**
   * A singleton for the length of one request, and gone with it.
   *
   * What every per-request service wants: one instance for the request, no
   * leaking into the next, and no hand-rolled slot and lifecycle in each package
   * that needs one. Outside a request it is an ordinary singleton, cleared by
   * `forgetScopedInstances()` — which is what a worker between two jobs wants.
   */
  scoped<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    return this.record(key, factory, { shared: true, scoped: true })
  }

  instance<K extends BindingKey>(key: K, value: Resolved<K>): this {
    const name = key as string
    const had = this.bound(key)
    const previous = had ? this.resolvedInstances.get(name) : undefined
    const finished = this.finish(name, value)

    this.resolvedInstances.set(name, finished)

    if (had && previous !== finished) this.announce(name, finished)

    return this
  }

  /** Bind only when nothing is bound — how a package offers a default. */
  bindIf<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    return this.bound(key) ? this : this.bind(key, factory)
  }

  /** The same, shared. */
  singletonIf<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    return this.bound(key) ? this : this.singleton(key, factory)
  }

  /** The same, per request. */
  scopedIf<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this {
    return this.bound(key) ? this : this.scoped(key, factory)
  }

  /**
   * Wrap what is already bound.
   *
   * Decorating without re-binding: a package that wants to add to the logger
   * keeps whatever anybody else did to it, instead of replacing the binding and
   * silently undoing them.
   */
  extend<K extends BindingKey>(
    key: K,
    wrap: (value: Resolved<K>, app: ApplicationContract) => Resolved<K>
  ): this {
    const name = key as string
    const wrapper = wrap as (value: unknown, app: ApplicationContract) => unknown
    const existing = this.extenders.get(name)

    if (existing) existing.push(wrapper)
    else this.extenders.set(name, [wrapper])

    // An instance is already built, so it is extended in place rather than on
    // some next resolution that will never come.
    if (this.resolvedInstances.has(name)) {
      this.resolvedInstances.set(name, wrapper(this.resolvedInstances.get(name), this))
    }

    return this
  }

  /**
   * Hear about it when a key is re-bound.
   *
   * An object that resolved a dependency at boot holds it for ever otherwise —
   * so swapping an implementation at runtime reaches nothing already built.
   */
  rebinding<K extends BindingKey>(
    key: K,
    callback: (value: Resolved<K>, app: ApplicationContract) => void
  ): this {
    const name = key as string
    const hook = callback as ResolutionHook
    const existing = this.rebindingHooks.get(name)

    if (existing) existing.push(hook)
    else this.rebindingHooks.set(name, [hook])

    return this
  }

  /** Resolve now and on every re-bind, handing the value to `holder[method]`. */
  refresh<K extends BindingKey, T extends object>(
    key: K,
    holder: T,
    method: keyof T & string
  ): this {
    const hand = (value: unknown): void => {
      ;(holder[method] as (value: unknown) => void).call(holder, value)
    }

    this.rebinding(key, hand)

    if (this.bound(key)) hand(this.make(key))

    return this
  }

  /**
   * Group keys under a name, so something can resolve a set it cannot enumerate.
   *
   * Every notification channel, every health check, every watcher: the framework
   * has to collect them without knowing in advance what an application added.
   */
  tag(keys: BindingKey | BindingKey[], ...tags: string[]): this {
    const names = (Array.isArray(keys) ? keys : [keys]).map((key) => key as string)

    for (const tag of tags) {
      const existing = this.tagged_.get(tag)

      if (existing) existing.push(...names)
      else this.tagged_.set(tag, [...names])
    }

    return this
  }

  /** Resolve everything under a tag. Unknown tag, empty list — not an error. */
  tagged<T = unknown>(tag: string): T[] {
    return (this.tagged_.get(tag) ?? []).map((name) => this.make(name as BindingKey) as T)
  }

  /**
   * A binding that differs by who is asking.
   *
   * ```ts
   * app.when('reports.mailer').needs('mail.transport').give(() => new SesTransport())
   * ```
   *
   * The consumer is whichever key's factory is running, so this works without
   * autowiring: the container knows what it is building while it builds it.
   */
  when(consumer: BindingKey | BindingKey[]): ContextualBuilder {
    const consumers = (Array.isArray(consumer) ? consumer : [consumer]).map((key) => key as string)

    return {
      needs: (key: BindingKey) => ({
        give: (implementation: Factory<unknown> | unknown) => {
          for (const name of consumers) {
            const forConsumer = this.contextual.get(name) ?? new Map<string, Factory<unknown>>()

            forConsumer.set(
              key as string,
              typeof implementation === 'function'
                ? (implementation as Factory<unknown>)
                : () => implementation
            )
            this.contextual.set(name, forConsumer)
          }

          return this
        }
      })
    }
  }

  /** Run before a key is resolved. `'*'` for every key. */
  beforeResolving(key: BindingKey | typeof ANY, callback: ResolvingHook): this {
    return this.hook(this.beforeHooks, key as string, callback as ResolutionHook)
  }

  /** Run on the value each time a key resolves, before the caller sees it. */
  resolving<K extends BindingKey>(
    key: K | typeof ANY,
    callback: (value: Resolved<K>, app: ApplicationContract) => void
  ): this {
    return this.hook(this.resolvingHooks, key as string, callback as ResolutionHook)
  }

  /** The same, after the `resolving` callbacks have had it. */
  afterResolving<K extends BindingKey>(
    key: K | typeof ANY,
    callback: (value: Resolved<K>, app: ApplicationContract) => void
  ): this {
    return this.hook(this.afterHooks, key as string, callback as ResolutionHook)
  }

  make<K extends BindingKey>(key: K): Resolved<K> {
    const name = key as string

    for (const hook of this.beforeHooks.get(ANY) ?? []) hook(name, this)
    for (const hook of this.beforeHooks.get(name) ?? []) hook(name, this)

    const contextual = this.contextualFor(name)

    if (contextual !== undefined) return this.fresh(name, contextual) as Resolved<K>

    if (this.resolvedInstances.has(name)) {
      return this.resolvedInstances.get(name) as Resolved<K>
    }

    const binding = this.bindings.get(name)
    if (!binding) {
      throw new Error(`Target [${name}] is not bound in the container.`)
    }

    const scope = binding.scoped === true ? this.scope() : undefined

    if (scope?.has(name)) return scope.get(name) as Resolved<K>

    const value = this.fresh(name, binding.factory)

    if (scope !== undefined) scope.set(name, value)
    else if (binding.shared) this.resolvedInstances.set(name, value)

    this.resolvedKeys.add(name)

    return value as Resolved<K>
  }

  bound(key: BindingKey): boolean {
    return this.bindings.has(key as string) || this.resolvedInstances.has(key as string)
  }

  /** Whether a key has ever been built — what `elvel about` reports as loaded. */
  resolved(key: BindingKey): boolean {
    return this.resolvedKeys.has(key as string) || this.resolvedInstances.has(key as string)
  }

  /** Whether resolving a key twice gives the same value. */
  isShared(key: BindingKey): boolean {
    return (
      this.resolvedInstances.has(key as string) || this.bindings.get(key as string)?.shared === true
    )
  }

  /** Every key, with how it is bound — for `elvel about` and for tests. */
  getBindings(): Array<{ key: string; shared: boolean; scoped: boolean; resolved: boolean }> {
    const keys = new Set([...this.bindings.keys(), ...this.resolvedInstances.keys()])

    return [...keys].sort().map((key) => ({
      key,
      shared: this.isShared(key as BindingKey),
      scoped: this.bindings.get(key)?.scoped === true,
      resolved: this.resolved(key as BindingKey)
    }))
  }

  /** Drop one built instance, keeping its binding, so the next `make` rebuilds. */
  forgetInstance(key: BindingKey): this {
    this.resolvedInstances.delete(key as string)
    this.scope().delete(key as string)

    return this
  }

  forgetInstances(): this {
    this.resolvedInstances.clear()

    return this
  }

  /** What a worker does between two jobs, and a request does when it ends. */
  forgetScopedInstances(): this {
    this.scope().clear()

    return this
  }

  /** Empty the container. For a test that wants a clean one without a new app. */
  flush(): this {
    this.bindings.clear()
    this.resolvedInstances.clear()
    this.resolvedKeys.clear()
    this.extenders.clear()
    this.rebindingHooks.clear()
    this.tagged_.clear()
    this.contextual.clear()
    this.beforeHooks.clear()
    this.resolvingHooks.clear()
    this.afterHooks.clear()
    this.scopedOutsideRequest.clear()

    return this
  }

  /** Bind, dropping whatever was built from the previous binding for that key. */
  private record<K extends BindingKey>(
    key: K,
    factory: Factory<Resolved<K>>,
    how: { shared: boolean; scoped?: boolean }
  ): this {
    const name = key as string
    const had = this.bound(key)

    this.bindings.set(name, { factory: factory as Factory<unknown>, ...how })
    this.resolvedInstances.delete(name)
    this.scope().delete(name)

    if (had) this.announce(name, undefined)

    return this
  }

  /** Build a value and run everything that wants to see it. */
  private fresh(name: string, factory: Factory<unknown>): unknown {
    this.building.push(name)

    let value: unknown

    try {
      value = factory(this)
    } finally {
      this.building.pop()
    }

    return this.finish(name, value)
  }

  /**
   * Everything that wants a say in a value, whether the container built it or
   * was handed it — an `instance()` is a resolution too, and a hook that missed
   * it would configure some objects of a type and not others.
   */
  private finish(name: string, built: unknown): unknown {
    let value = built

    for (const wrap of this.extenders.get(name) ?? []) value = wrap(value, this)

    for (const hook of this.resolvingHooks.get(ANY) ?? []) hook(value, this)
    for (const hook of this.resolvingHooks.get(name) ?? []) hook(value, this)
    for (const hook of this.afterHooks.get(ANY) ?? []) hook(value, this)
    for (const hook of this.afterHooks.get(name) ?? []) hook(value, this)

    return value
  }

  /** The contextual factory for this key, given whatever is being built. */
  private contextualFor(name: string): Factory<unknown> | undefined {
    const consumer = this.building.at(-1)

    return consumer === undefined ? undefined : this.contextual.get(consumer)?.get(name)
  }

  /** Tell everybody watching this key that it changed. */
  private announce(name: string, value: unknown): void {
    const hooks = this.rebindingHooks.get(name)

    if (hooks === undefined || hooks.length === 0) return

    const current =
      value ?? (this.bound(name as BindingKey) ? this.make(name as BindingKey) : undefined)

    for (const hook of hooks) hook(current, this)
  }

  private hook(into: Map<string, ResolutionHook[]>, key: string, callback: ResolutionHook): this {
    const existing = into.get(key)

    if (existing) existing.push(callback)
    else into.set(key, [callback])

    return this
  }

  /**
   * Where scoped instances live: the request's context inside one, a map on the
   * application outside — a worker or a command, where `forgetScopedInstances`
   * is what ends the scope.
   */
  private scope(): Map<string, unknown> {
    if (!inRequestContext()) return this.scopedOutsideRequest

    let held = scopedSlot.get()

    if (held === undefined) {
      held = new Map<string, unknown>()
      scopedSlot.set(held)
    }

    return held
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

  /** Is the application in maintenance mode? Read from disk, not cached. */
  async isDownForMaintenance(): Promise<boolean> {
    return this.make('maintenance').active()
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

    // Before the providers, so anything formatting a number at boot already has
    // the application's locale rather than `en`.
    useLocale(this.config.get<string>('app.locale', 'en'))

    // What `rescue()` swallows still reaches the log, which is the whole
    // difference between it and a bare try/catch.
    reportRescuedUsing((error) => {
      if (this.bound('exception.handler')) this.make('exception.handler').report(error)
    })

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

  /**
   * Run `callback` when the process is shutting down.
   *
   * For the work that has to happen once, at the end: closing a pool, flushing a
   * buffered writer, telling a supervisor it is leaving cleanly. Registered on
   * SIGINT and SIGTERM the first time one of these is added, because a container
   * gets SIGTERM and fifteen seconds, and a process that ignores it is a process
   * killed mid-write.
   *
   * Callbacks run in order and a failure in one does not stop the rest: shutdown
   * is the worst moment to abandon the remaining cleanup.
   */
  terminating(callback: (app: ApplicationContract) => void | Promise<void>): this {
    this.terminatingCallbacks.push(callback)

    if (!this.listeningForShutdown) {
      this.listeningForShutdown = true

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          void this.terminate().then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
        })
      }
    }

    return this
  }

  /** Run the shutdown callbacks. Called by the signal handlers, and by tests. */
  async terminate(): Promise<void> {
    // Taken and cleared first: a callback that registers another must not make
    // this loop endless, and terminating twice must not run anything twice.
    const callbacks = [...this.terminatingCallbacks]
    this.terminatingCallbacks.length = 0

    for (const callback of callbacks) {
      try {
        await callback(this)
      } catch (error) {
        // Reported, not thrown: the remaining cleanup matters more than this one.
        console.error('[terminating]', error instanceof Error ? error.message : String(error))
      }
    }
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

  /**
   * Wire the exception handler into Elysia's error pipeline.
   *
   * The handler is resolved **per error**, not once here, and that is the whole
   * point of the line. This runs at step 3 of `create()`, before a single
   * provider has registered — so closing over the instance made
   * `exception.handler` a binding nothing could ever replace, while the comment
   * beside step 4 promised that application providers may override framework
   * bindings. Found by trying: an application that rebound it in a provider's
   * `register()` still got the framework's own 404 page.
   *
   * A container lookup per error is a Map read on a path that only runs when
   * something already went wrong.
   */
  /**
   * Set by `withoutExceptionHandling()`. A static because the error hook is
   * registered once, at boot, and a test flips this between requests.
   */
  static rethrowExceptions = false

  handleExceptions(): this {
    this.router.onError(async ({ error, request, set }) => {
      const handler = this.make('exception.handler')

      /**
       * Put the request's scopes back, **before** anything reads them.
       *
       * Every per-request hook belongs to a handler, and this path has none —
       * nothing matched, or something threw on the way there. Without this, a
       * handler rendering a page for a 404 reads no session and no user: measured
       * as `user: null` and `csrf: ''` on a request whose cookie the very next
       * endpoint accepted.
       *
       * Synchronous, and called before the first `await` for the reason
       * `enterWith` exists — it applies to the rest of this execution and the
       * continuations scheduled from it, so entering after an `await` would land
       * in a frame `render` never sees.
       */
      const lifecycle = this.make('request.lifecycle')

      await lifecycle.prepare(request)
      lifecycle.enter(request)

      /**
       * A test that turned handling off sees the exception itself.
       *
       * The stack, the message and the line are all inside the handler that
       * turned the exception into a response, and the only way to see them was
       * to edit the application.
       */
      if (Application.rethrowExceptions) throw error

      void handler.report(error)

      // `render` may be async — the contract allows it, so this awaits rather
      // than reading `.status` off a promise.
      const response = await handler.render(error, { request })

      /**
       * The handler's status wins, even over one already decided.
       *
       * A plugin may have handled the error in its own scope first — and
       * `@elysiajs/static` does exactly that, swallowing the `NOT_FOUND` it
       * throws for a missing file. By the time this hook runs the status is
       * pinned, and a `Response` returned from here does not lift it: measured on
       * that plugin's shape, a handler answering `200` with a document still went
       * out as `404`, right body and wrong code.
       *
       * Which broke the one thing a handler most obviously wants to do — turn an
       * error into an ordinary answer. A single-page application's deep link is
       * that: `/invoices/9` is not missing, the client router owns it, and the
       * document is a 200.
       */
      set.status = response.status

      /**
       * And what the response still owes, now that it exists.
       *
       * `onAfterHandle` is where the session is saved and its cookie re-issued,
       * and it belongs to a handler this path never had: measured, an unmatched
       * request came back with **no `Set-Cookie` at all**, so a document rendered
       * here handed the client a token for a session nobody stored. Awaited,
       * because saving is a write.
       */
      await lifecycle.finish(request, response)

      return response
    })

    return this
  }

  // -------------------------------------------------------------------- serve

  async listen(port?: number, hostname?: string): Promise<Application> {
    const resolvedPort = port ?? this.config.integer('app.port', Env.number('PORT', 3000))
    const resolvedHost = hostname ?? this.config.get<string>('app.host', Env.string('HOST', ''))

    /**
     * Refuse a port somebody else holds, rather than reporting success on it.
     *
     * On Windows a second bind to the same port succeeds — `SO_REUSEADDR` allows
     * it — so two servers end up listening and requests go to whichever socket
     * wins. Measured: a second `serve` printed `Server running on
     * http://localhost:3000` while another process was already there, and
     * `netstat` showed both. What it looks like from the terminal is a server that
     * cannot be killed, because the old one keeps answering.
     */
    /**
     * Except when the thing holding it is this process, one reload ago.
     *
     * `bun --hot` re-evaluates the module graph in place: the entry runs again,
     * builds a fresh application, and binds the same port — while the server
     * from the previous evaluation is still listening on it, in this very
     * process. The probe cannot tell that apart from a second terminal, so
     * without this every edit ended `dev` with "port 3000 is already in use",
     * naming the developer's own server.
     *
     * `Bun.serve` handles the rebind itself under `--hot`, replacing the handler
     * rather than opening a second socket. Recorded on `globalThis` because that
     * is what survives a reload — a module-level `Set` is re-created empty by
     * the very reload it needs to remember.
     */
    const bound = boundPorts()

    if (this.config.get<boolean>('http.checkPort', true) !== false && !bound.has(resolvedPort)) {
      const probeHost = resolvedHost === '' ? '127.0.0.1' : resolvedHost

      if (await portInUse(resolvedPort, probeHost)) {
        throw new PortInUseError(portInUseMessage(resolvedPort, resolvedHost))
      }
    }

    bound.add(resolvedPort)

    /**
     * The limit on a request body, refused at the socket before a byte reaches
     * the application.
     *
     * Measured through Elysia, all three cases: a declared `Content-Length`
     * over the limit is 413 before the handler; a chunked body is 413 as soon
     * as the handler reads it; a chunked body no handler reads is served, and
     * costs nothing, because nothing buffered it.
     */
    const maxBodySize = this.config.integer('http.maxBodySize', 10 * 1024 * 1024)

    this.router.listen({
      port: resolvedPort,
      ...(resolvedHost === '' ? {} : { hostname: resolvedHost }),
      ...(maxBodySize > 0 ? { maxRequestBodySize: maxBodySize } : {})
    })

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
 * Fluent bootstrapper:
 * `Application.configure(...).withProviders(...).create()`.
 */
export class ApplicationBuilder {
  private readonly providers: ServiceProviderConstructor[] = []
  private readonly routeLoaders: RouteLoader[] = []
  private readonly consoleLoaders: Array<() => Promise<unknown>> = []
  private readonly middlewareCallbacks: Array<(middleware: MiddlewareConfigurator) => void> = []
  private readonly exceptionCallbacks: Array<(exceptions: ExceptionRules) => void> = []
  private configLoaders: ConfigLoaders | undefined

  constructor(private readonly basePath: string) {}

  /**
   * Name the config files instead of letting the directory be read.
   *
   * The default reads `config/` and imports whatever is in it, which is right
   * for development and cannot survive bundling: those imports are resolved at
   * run time against the disk, so a bundled application loads a *second* copy of
   * the framework through them — and `Application.current`, which the helpers in
   * a config file reach for, belongs to the copy that is not running.
   *
   * ```ts
   * .withConfig({
   *   app: () => import('../config/app.ts'),
   *   database: () => import('../config/database.ts')
   * })
   * ```
   *
   * The loaders are lazy for the same reason the route loaders are: a config
   * file may call `storage_path()` while it is being evaluated, and that needs
   * an application to exist first. Bundlers can still follow a literal
   * `import('./x.ts')`, so everything ends up in the bundle and there is only
   * one copy of anything.
   */
  withConfig(loaders: ConfigLoaders): this {
    this.configLoaders = { ...this.configLoaders, ...loaders }

    return this
  }

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

  /**
   * Load a module for its registrations rather than for its routes.
   *
   * `routes/console.ts` is the case this exists for. Such
   * a file has no default export and mounts nothing: it calls `schedule()` and
   * registers commands, and what it needs is to be imported once, after the
   * providers have booted and before anything runs.
   *
   * ```ts
   * .withConsole(() => import('../routes/console.ts'))
   * ```
   */
  withConsole(...loaders: Array<() => Promise<unknown>>): this {
    this.consoleLoaders.push(...loaders)
    return this
  }

  /**
   * Shape the middleware stack from `bootstrap/app.ts` rather than from inside a
   * provider.
   *
   * ```ts
   * .withMiddleware((middleware) => {
   *   middleware.alias('subscribed', () => requireSubscription())
   *   middleware.group('dashboard', ['auth', 'verified', 'subscribed'])
   *   middleware.append(auditPlugin())
   * })
   * ```
   *
   * `append` and no `prepend`: Elysia composes hooks in mount order, and the
   * framework's own have to run first — the request scope is entered by the
   * first of them, and anything mounted ahead of it would read a scope that does
   * not exist yet. A middleware that must see a request before the framework
   * does belongs in front of the application, not inside it.
   *
   * Run after the providers boot, because that is when the registry exists.
   */
  withMiddleware(callback: (middleware: MiddlewareConfigurator) => void): this {
    this.middlewareCallbacks.push(callback)

    return this
  }

  /**
   * Say how exceptions are reported and rendered.
   *
   * ```ts
   * .withExceptions((exceptions) => {
   *   exceptions.dontReport(ThrottleException)
   *   exceptions.render(PaymentRequired, () => Response.json({ upgrade: true }, { status: 402 }))
   * })
   * ```
   *
   * Customising one exception meant replacing the container binding, which is a
   * subclass of the handler and a provider to bind it — for a rule that is two
   * lines.
   */
  withExceptions(callback: (exceptions: ExceptionRules) => void): this {
    this.exceptionCallbacks.push(callback)

    return this
  }

  async create(): Promise<Application> {
    const app = new Application(this.basePath)

    // 1. env
    await Env.load(this.basePath, Env.string('APP_ENV', ''))

    /**
     * 2. config — from the cache when there is one.
     *
     * A cached config skips reading and importing every file in `config/`. It
     * matters less than it might, since Bun's module cache already
     * absorbs most of that cost, but it is also what lets a container image
     * ship a config it cannot accidentally re-evaluate.
     */
    app.config = this.configLoaders
      ? await Config.loadUsing(this.configLoaders)
      : ((await Config.loadCached(
          app.basePath('bootstrap', 'cache', 'config.json'),
          app.configPath()
        )) ?? (await Config.loadFrom(app.configPath())))

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

    /**
     * 5a. the builder's own rules, after everything they configure exists.
     *
     * Exceptions before middleware, so a middleware appended here that throws is
     * already covered by the rules the application declared for it.
     */
    for (const callback of this.exceptionCallbacks) {
      callback(app.make('exception.handler') as unknown as ExceptionRules)
    }

    if (this.middlewareCallbacks.length > 0) {
      if (!app.bound('middleware')) {
        throw new Error(
          'withMiddleware() needs the HTTP package. Register HttpServiceProvider in bootstrap/providers.ts, or drop the call.'
        )
      }

      const registry = app.make('middleware' as never) as MiddlewareConfigurator

      for (const callback of this.middlewareCallbacks) {
        callback({
          alias: (name, factory) => registry.alias(name, factory),
          group: (name, names) => registry.group(name, names),
          priority: (names) => registry.priority(names),
          append: (plugin) => app.useRoutes(plugin)
        })
      }
    }

    // 6. console registrations — schedules and commands, which are not routes
    //    and have nothing to mount, but do need the container populated.
    for (const loader of this.consoleLoaders) await loader()

    // 7. routes — last, so handlers can resolve anything a provider bound
    for (const loader of this.routeLoaders) {
      const module = await loader()

      /**
       * A routes file need not export anything.
       *
       * ```ts
       * // routes/web.ts
       * Route.get('/', [PageController, 'index'])
       * ```
       *
       * That is `routes/web.php`, and it is the DX this framework is copying.
       * `Route.*` collects what the file declared while it was imported, and the
       * compiler — bound by `HttpServiceProvider` as `routes.compiler` — turns the
       * collection into a plugin. Asked of the container rather than imported,
       * because routing lives in `@elvel/http` and this file is `@elvel/core`:
       * the dependency only runs in that direction.
       *
       * A module that *does* export a default is still mounted as it always was,
       * so a package shipping an Elysia plugin needs no rewriting.
       */
      if (module.default !== undefined) {
        app.useRoutes(module.default)

        continue
      }

      if (!app.bound('routes.compiler')) {
        throw new Error(
          'A routes file exported nothing, and no route compiler is bound. ' +
            'Register HttpServiceProvider in bootstrap/providers.ts, or give the ' +
            'file a default of its own — an Elysia plugin.'
        )
      }

      app.useRoutes(app.make('routes.compiler')())
    }

    return app
  }
}

/**
 * The ports this *process* has already bound, across hot reloads.
 *
 * On `globalThis` deliberately: `bun --hot` re-evaluates modules and re-creates
 * module-level state, so a `Set` declared here would be empty again on exactly
 * the reload that needs to consult it. The global object is what Bun preserves.
 *
 * Read by `listen()`, to tell "somebody else is on this port" apart from "I am,
 * from the evaluation before this one".
 */
function boundPorts(): Set<number> {
  const host = globalThis as { __elvelBoundPorts?: Set<number> }

  host.__elvelBoundPorts ??= new Set<number>()

  return host.__elvelBoundPorts
}
