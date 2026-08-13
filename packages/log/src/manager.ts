import type {
  ApplicationContract,
  EventDispatcher,
  LogContext,
  LogDriver,
  LoggerContract,
  LogLevel
} from '@elysian/contracts'
import { ConsoleDriver } from './drivers/console.ts'
import { DailyDriver, FileDriver } from './drivers/file.ts'
import { JsonDriver } from './drivers/json.ts'
import {
  ErrorLogDriver,
  MemoryDriver,
  NullDriver,
  SlackDriver,
  StackDriver
} from './drivers/misc.ts'
import { severityOf } from './levels.ts'
import { Logger } from './logger.ts'

export type ChannelConfig = {
  driver: 'console' | 'json' | 'single' | 'daily' | 'stack' | 'null' | 'memory' | (string & {})
  level?: LogLevel
  /** `stack` only: the channels to fan out to. */
  channels?: string[]
  /** `single` / `daily` only. */
  path?: string
  /** `daily` only. */
  maxFiles?: number
  /** `console` / `json` only. */
  stream?: 'stdout' | 'stderr'
  colours?: boolean
  [option: string]: unknown
}

export type DriverFactory = (config: ChannelConfig, name: string) => LogDriver

/**
 * Resolves and caches log channels — `Illuminate\Log\LogManager`.
 *
 * The manager is itself a logger: `log.info(...)` writes to the default
 * channel, exactly as the `Log` facade does.
 */
export class LogManager implements LoggerContract {
  private readonly channels = new Map<string, Logger>()
  private readonly custom = new Map<string, DriverFactory>()
  private shared: LogContext = {}

  constructor(private readonly app: ApplicationContract) {}

  /** Register a driver of your own: `log.extend('pino', config => …)`. */
  extend(driver: string, factory: DriverFactory): this {
    this.custom.set(driver, factory)
    return this
  }

  getDefaultDriver(): string {
    return this.app.config.get<string>('logging.default', 'console')
  }

  setDefaultDriver(name: string): void {
    this.app.config.set('logging.default', name)
  }

  channel(name?: string): Logger {
    return this.driver(name)
  }

  driver(name?: string): Logger {
    const resolved = name ?? this.getDefaultDriver()
    const cached = this.channels.get(resolved)
    if (cached) return cached

    const logger = this.resolve(resolved)
    this.channels.set(resolved, logger)

    return logger
  }

  /** An on-demand stack, without declaring it in config. */
  stack(channels: string[], name = 'stack'): Logger {
    return new Logger({
      channel: name,
      driver: new StackDriver(channels.map((channel) => this.driverFor(channel))),
      context: this.shared,
      dispatcher: this.dispatcher()
    })
  }

  /** An on-demand channel from inline config — `Log::build()`. */
  build(config: ChannelConfig, name = 'ondemand'): Logger {
    return this.make(name, config)
  }

  forgetChannel(name?: string): void {
    this.channels.delete(name ?? this.getDefaultDriver())
  }

  getChannels(): Map<string, Logger> {
    return new Map(this.channels)
  }

  /** Context added to every channel, present and future. */
  shareContext(context: LogContext): this {
    this.shared = { ...this.shared, ...context }

    for (const logger of this.channels.values()) {
      logger.withContext(context)
    }

    return this
  }

  sharedContext(): LogContext {
    return { ...this.shared }
  }

  flushSharedContext(): this {
    this.shared = {}

    for (const logger of this.channels.values()) {
      logger.withoutContext()
    }

    return this
  }

  private resolve(name: string): Logger {
    const config = this.app.config.get<ChannelConfig | undefined>(`logging.channels.${name}`)

    if (!config) {
      throw new Error(
        `Log channel [${name}] is not defined. Add it to config/logging.ts under "channels".`
      )
    }

    return this.make(name, config)
  }

  private make(name: string, config: ChannelConfig): Logger {
    // Validate eagerly so a typo in config fails at boot, not at 3am.
    if (config.level) severityOf(config.level)

    return new Logger({
      channel: name,
      driver: this.driverFor(name, config),
      level: config.level ?? 'debug',
      context: this.shared,
      dispatcher: this.dispatcher()
    })
  }

  private driverFor(name: string, config?: ChannelConfig): LogDriver {
    const resolved =
      config ?? this.app.config.get<ChannelConfig | undefined>(`logging.channels.${name}`)

    if (!resolved) {
      throw new Error(`Log channel [${name}] is not defined.`)
    }

    const custom = this.custom.get(resolved.driver)
    if (custom) return custom(resolved, name)

    switch (resolved.driver) {
      case 'console':
        return new ConsoleDriver({
          colours: resolved.colours ?? !this.app.isProduction(),
          ...(resolved.stderrFrom ? { stderrFrom: resolved.stderrFrom as LogLevel } : {})
        })

      case 'json':
        return new JsonDriver({ stream: resolved.stream ?? 'stdout' })

      case 'single':
        return new FileDriver(this.pathFor(resolved, 'elysian.log'))

      case 'daily':
        return new DailyDriver(this.pathFor(resolved, 'elysian.log'), {
          maxFiles: resolved.maxFiles ?? 14
        })

      case 'stack': {
        const channels = resolved.channels ?? []
        if (channels.includes(name)) {
          throw new Error(`Log stack [${name}] cannot include itself.`)
        }

        return new StackDriver(channels.map((channel) => this.driverFor(channel)))
      }

      case 'errorlog':
        return new ErrorLogDriver()

      case 'slack':
        return new SlackDriver(
          {
            url: String(resolved.url ?? ''),
            username: resolved.username as string | undefined,
            emoji: resolved.emoji as string | undefined,
            level: (resolved.level as string | undefined) ?? 'error'
          },
          (error) => {
            // Straight to stderr: reporting a logging failure through the log is
            // how a broken channel becomes an infinite loop.
            process.stderr.write(
              `[log] slack delivery failed: ${error instanceof Error ? error.message : String(error)}\n`
            )
          }
        )

      case 'memory':
        return new MemoryDriver()

      case 'null':
        return new NullDriver()

      default:
        throw new Error(
          `Log driver [${resolved.driver}] is not supported. Register it with log.extend().`
        )
    }
  }

  private pathFor(config: ChannelConfig, fallback: string): string {
    return config.path ?? this.app.storagePath('logs', fallback)
  }

  private dispatcher(): EventDispatcher | undefined {
    // Optional on purpose: log must work before the event dispatcher exists.
    return this.app.bound('events')
      ? (this.app.make('events' as never) as EventDispatcher)
      : undefined
  }

  // The manager proxies the default channel, like the Log facade.

  log(level: LogLevel, message: string, context?: LogContext): void {
    this.driver().log(level, message, context)
  }

  emergency(message: string, context?: LogContext): void {
    this.driver().emergency(message, context)
  }

  alert(message: string, context?: LogContext): void {
    this.driver().alert(message, context)
  }

  critical(message: string, context?: LogContext): void {
    this.driver().critical(message, context)
  }

  error(message: string, context?: LogContext): void {
    this.driver().error(message, context)
  }

  warning(message: string, context?: LogContext): void {
    this.driver().warning(message, context)
  }

  notice(message: string, context?: LogContext): void {
    this.driver().notice(message, context)
  }

  info(message: string, context?: LogContext): void {
    this.driver().info(message, context)
  }

  debug(message: string, context?: LogContext): void {
    this.driver().debug(message, context)
  }

  withContext(context: LogContext): this {
    this.driver().withContext(context)
    return this
  }

  withoutContext(keys?: string[]): this {
    this.driver().withoutContext(keys)
    return this
  }
}
