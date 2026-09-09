import type { LogLevel } from '@elvel/contracts'

/**
 * Level priorities, PSR-3's numbers — the ones Telescope's `LogWatcher` uses.
 *
 * The values matter only in comparison, but they are kept as PSR-3 wrote them
 * so a reader coming from either framework recognises them.
 */
export const PRIORITIES: Record<LogLevel, number> = {
  debug: 100,
  info: 200,
  notice: 250,
  warning: 300,
  error: 400,
  critical: 500,
  alert: 550,
  emergency: 600
}

/** Is `level` at or above `minimum`? Anything unrecognised counts as `debug`. */
export function atLeast(level: string, minimum: string): boolean {
  const found = PRIORITIES[level as LogLevel] ?? PRIORITIES.debug
  const floor = PRIORITIES[minimum as LogLevel] ?? PRIORITIES.debug

  return found >= floor
}
