import type { LogDriver, LogLevel, LogRecord } from '@elysian/contracts'
import pc from 'picocolors'

const COLOURS: Record<LogLevel, (value: string) => string> = {
  emergency: (value) => pc.bgRed(pc.white(value)),
  alert: (value) => pc.bgRed(pc.white(value)),
  critical: (value) => pc.bgRed(pc.white(value)),
  error: pc.red,
  warning: pc.yellow,
  notice: pc.cyan,
  info: pc.blue,
  debug: pc.dim
}

export type ConsoleDriverOptions = {
  /** Print to stderr from this level up. Defaults to `error`. */
  stderrFrom?: LogLevel
  colours?: boolean
}

/**
 * Human-readable output for development:
 *
 *   14:02:31 INFO  [single] User registered  { id: 7 }
 */
export class ConsoleDriver implements LogDriver {
  constructor(private readonly options: ConsoleDriverOptions = {}) {}

  write(record: LogRecord): void {
    const paint = this.options.colours === false ? (value: string) => value : COLOURS[record.level]
    const time = record.time.toTimeString().slice(0, 8)
    const level = paint(record.level.toUpperCase().padEnd(9))
    const channel = this.options.colours === false ? record.channel : pc.dim(record.channel)

    const context =
      Object.keys(record.context).length > 0
        ? ` ${Bun.inspect(record.context, { colors: false })}`
        : ''

    const line = `${time} ${level} [${channel}] ${record.message}${context}`

    // console.error goes to stderr, which keeps error output separable in
    // production log collectors even when both streams are captured.
    if (this.usesStderr(record.level)) console.error(line)
    else console.log(line)
  }

  private usesStderr(level: LogLevel): boolean {
    const threshold = this.options.stderrFrom ?? 'error'
    const order: LogLevel[] = [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency'
    ]

    return order.indexOf(level) >= order.indexOf(threshold)
  }
}
