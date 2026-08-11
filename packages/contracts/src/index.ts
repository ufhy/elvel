import type { Elysia } from 'elysia'

/**
 * Config repository — the `config('app.name')` backing store.
 */
export interface ConfigRepository {
  has(key: string): boolean
  get<T = unknown>(key: string): T
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  all(): Record<string, unknown>
}

/**
 * Bindings registered in the container.
 *
 * Packages augment this interface so `app.make('view')` is typed instead of
 * returning `unknown`. This is how we keep Laravel's ergonomics without
 * Laravel's string-keyed blindness:
 *
 * ```ts
 * declare module '@elysian/contracts' {
 *   interface ContainerBindings {
 *     view: ViewFactory
 *   }
 * }
 * ```
 *
 * It must stay an `interface`: a type alias cannot be augmented, and turning it
 * into one silently degrades every `make()` call back to `unknown`.
 */
// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target
export interface ContainerBindings {}

export type BindingKey = keyof ContainerBindings | (string & {})

export type Resolved<K> = K extends keyof ContainerBindings ? ContainerBindings[K] : unknown

export type Factory<T = unknown> = (app: ApplicationContract) => T

export interface Container {
  bind<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this
  singleton<K extends BindingKey>(key: K, factory: Factory<Resolved<K>>): this
  instance<K extends BindingKey>(key: K, value: Resolved<K>): this
  make<K extends BindingKey>(key: K): Resolved<K>
  bound(key: BindingKey): boolean
}

export type AppEnvironment = 'local' | 'testing' | 'staging' | 'production' | (string & {})

export interface ApplicationContract extends Container {
  readonly config: ConfigRepository

  /** The root Elysia instance every provider composes into. */
  readonly router: Elysia

  basePath(...segments: string[]): string
  configPath(...segments: string[]): string
  appPath(...segments: string[]): string
  resourcePath(...segments: string[]): string
  routesPath(...segments: string[]): string
  publicPath(...segments: string[]): string
  storagePath(...segments: string[]): string

  environment(): AppEnvironment
  isProduction(): boolean
  isLocal(): boolean
  hasDebugModeEnabled(): boolean

  register(provider: ServiceProviderConstructor): Promise<this>
  booted(callback: (app: ApplicationContract) => void | Promise<void>): this
}

export interface ServiceProviderContract {
  /** Bind things into the container. Never resolve other services here. */
  register(): void | Promise<void>
  /** Everything is registered by now — safe to resolve and wire routes. */
  boot?(): void | Promise<void>
}

export interface ServiceProviderConstructor {
  new (app: ApplicationContract): ServiceProviderContract
}

/**
 * View factory — `view('pages.landing', { ... })`.
 */
export interface ViewFactory {
  render(template: string, data?: Record<string, unknown>): Promise<string>
  share(key: string, value: unknown): this
  mount(name: string, directory: string): this
}

/**
 * A console command. Mirrors Artisan's signature-driven contract.
 */
export interface CommandContract {
  readonly signature: string
  readonly description: string
  handle(): Promise<number | void> | number | void
}

export interface CommandConstructor {
  new (...args: any[]): CommandContract
  readonly signature: string
  readonly description: string
}

export interface ExceptionHandlerContract {
  report(error: unknown): void | Promise<void>
  render(error: unknown, context: { request: Request }): Response | Promise<Response>
}
