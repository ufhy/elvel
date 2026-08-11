import type {
  EventDispatcher,
  LogContext,
  LogDriver,
  LoggerContract,
  LogLevel,
  LogRecord
} from '@elysian/contracts'
import { isHandling } from './levels.ts'

/**
 * Emitted after every written record, so a listener can forward logs elsewhere
 * without wrapping the logger. This is the `MessageLogged` event that
 * `Illuminate\Log\Logger::writeLog` fires.
 */
export class MessageLogged {
  static readonly eventName = 'log.message'

  constructor(
    readonly level: LogLevel,
    readonly message: string,
    readonly context: LogContext,
    readonly channel: string
  ) {}
}

export type LoggerOptions = {
  channel: string
  driver: LogDriver
  /** Minimum level this channel handles. Defaults to `debug`. */
  level?: LogLevel
  context?: LogContext
  dispatcher?: EventDispatcher
  /** Injectable clock so tests do not depend on the wall clock. */
  now?: () => Date
}

/**
 * A single log channel: a level threshold, some sticky context, and a driver.
 */
export class Logger implements LoggerContract {
  private context: LogContext

  constructor(private readonly options: LoggerOptions) {
    this.context = { ...(options.context ?? {}) }
  }

  get channel(): string {
    return this.options.channel
  }

  log(level: LogLevel, message: string, context: LogContext = {}): void {
    // Bail before formatting: a debug call in production should cost nothing.
    if (!isHandling(level, this.options.level ?? 'debug')) return

    const merged = { ...this.context, ...context }
    const rendered = interpolate(message, merged)

    const record: LogRecord = {
      level,
      message: rendered,
      context: merged,
      channel: this.options.channel,
      time: this.options.now ? this.options.now() : new Date()
    }

    // Drivers may be async (file writes); a caller that needs the flush can
    // await `write()` on the driver directly. Logging never blocks a request.
    void this.options.driver.write(record)

    void this.options.dispatcher?.dispatch(
      new MessageLogged(level, rendered, merged, this.options.channel)
    )
  }

  emergency(message: string, context?: LogContext): void {
    this.log('emergency', message, context)
  }

  alert(message: string, context?: LogContext): void {
    this.log('alert', message, context)
  }

  critical(message: string, context?: LogContext): void {
    this.log('critical', message, context)
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context)
  }

  warning(message: string, context?: LogContext): void {
    this.log('warning', message, context)
  }

  notice(message: string, context?: LogContext): void {
    this.log('notice', message, context)
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context)
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context)
  }

  /** Attach context to every subsequent record on this channel. */
  withContext(context: LogContext): this {
    this.context = { ...this.context, ...context }
    return this
  }

  withoutContext(keys?: string[]): this {
    if (!keys) {
      this.context = {}
      return this
    }

    for (const key of keys) delete this.context[key]
    return this
  }

  sharedContext(): LogContext {
    return { ...this.context }
  }
}

/**
 * Replace `{placeholders}` with context values, as Monolog's
 * PsrLogMessageProcessor does for `replace_placeholders`.
 */
export function interpolate(message: string, context: LogContext): string {
  if (!message.includes('{')) return message

  return message.replace(/\{([\w.]+)\}/g, (match, key: string) => {
    const value = context[key]
    if (value === undefined) return match

    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}
