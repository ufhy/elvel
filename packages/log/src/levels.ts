import type { LogLevel } from '@elysian/contracts'

/**
 * RFC 5424 levels in descending severity, exactly the eight Laravel exposes.
 * The numbers are Monolog's, so a channel's minimum `level` behaves the same.
 */
export const LEVELS: Record<LogLevel, number> = {
  emergency: 600,
  alert: 550,
  critical: 500,
  error: 400,
  warning: 300,
  notice: 250,
  info: 200,
  debug: 100
}

export const LEVEL_NAMES = Object.keys(LEVELS) as LogLevel[]

export class InvalidLogLevelError extends Error {
  constructor(level: string) {
    super(`Invalid log level [${level}]. Expected one of: ${LEVEL_NAMES.join(', ')}.`)
    this.name = 'InvalidLogLevelError'
  }
}

/** Resolve a configured level, rejecting typos rather than defaulting silently. */
export function severityOf(level: string): number {
  const severity = LEVELS[level as LogLevel]
  if (severity === undefined) throw new InvalidLogLevelError(level)

  return severity
}

export function isHandling(level: LogLevel, minimum: LogLevel): boolean {
  return LEVELS[level] >= severityOf(minimum)
}
