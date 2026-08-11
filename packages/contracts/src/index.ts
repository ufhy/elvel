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
 * A view is a function returning markup — exactly what a `@kitajs/html`
 * component compiles to. Async components are allowed, hence the union.
 */
export type ViewComponent<Props = {}> = (props: Props) => string | Promise<string>

/**
 * View renderer.
 *
 * Views are passed as components, not as string names: that is what lets
 * TypeScript check the props at the call site. There is no `share()` — with JSX
 * there is no template scope to inject globals into, so shared data is imported
 * like any other value (`config()`, a helper, a plain module).
 */
export interface ViewFactory {
  render<Props>(component: ViewComponent<Props>, props: Props): Promise<string>
}

// ------------------------------------------------------------------- events

/** A class-based event: `dispatch(new UserRegistered(user))`. */
export type EventConstructor<E extends object = object> = abstract new (...args: any[]) => E

/**
 * How an event is addressed. A constructor keeps listeners typed; a string
 * supports loose events and `'user.*'` wildcard patterns.
 */
export type EventKey<E extends object = object> = EventConstructor<E> | string

export type Listener<Payload = any> = (payload: Payload) => unknown | Promise<unknown>

/** Wildcard listeners receive the resolved event name alongside the payload. */
export type WildcardListener = (event: string, payload: unknown) => unknown | Promise<unknown>

export interface EventSubscriber {
  subscribe(dispatcher: EventDispatcher): void
}

export interface EventDispatcher {
  /** Class events keep their payload typed. */
  listen<E extends object>(event: EventConstructor<E>, listener: Listener<E>): void
  /**
   * String events are the loose path: an exact name calls `(payload)`, while a
   * pattern such as `'order.*'` calls `(eventName, payload)`. The signature is
   * intentionally permissive because one overload has to serve both.
   */
  listen(event: string | string[], listener: (...args: any[]) => unknown | Promise<unknown>): void

  hasListeners(event: EventKey): boolean

  subscribe(subscriber: EventSubscriber): void

  /** Dispatch and return every listener's response. */
  dispatch<E extends object>(event: E): Promise<unknown[] | null>
  dispatch(event: string, payload?: unknown): Promise<unknown[] | null>

  /** Dispatch until the first non-null response, and return it. */
  until<E extends object>(event: E): Promise<unknown>
  until(event: string, payload?: unknown): Promise<unknown>

  push(event: string, payload?: unknown): void
  flush(event: string): Promise<void>
  forget(event: EventKey): void
  forgetPushed(): void
}

// ---------------------------------------------------------------------- log

/** RFC 5424 levels, as Laravel exposes them. */
export type LogLevel =
  | 'emergency'
  | 'alert'
  | 'critical'
  | 'error'
  | 'warning'
  | 'notice'
  | 'info'
  | 'debug'

export type LogContext = Record<string, unknown>

export type LogRecord = {
  level: LogLevel
  message: string
  context: LogContext
  channel: string
  time: Date
}

/** A single log channel. */
export interface LoggerContract {
  log(level: LogLevel, message: string, context?: LogContext): void
  emergency(message: string, context?: LogContext): void
  alert(message: string, context?: LogContext): void
  critical(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  warning(message: string, context?: LogContext): void
  notice(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  debug(message: string, context?: LogContext): void
  withContext(context: LogContext): this
  withoutContext(keys?: string[]): this
}

/** Writes a formatted record somewhere: a file, stdout, a remote service. */
export interface LogDriver {
  write(record: LogRecord): void | Promise<void>
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
