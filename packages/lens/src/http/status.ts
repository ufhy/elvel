import type { EntryTypeName } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import type { WatcherConfig } from '../watchers/index.ts'

/**
 * Why a list is empty, which is worth more than the empty list.
 *
 * Telescope's four words, and its order: the master switch first, then a manual
 * pause, then the individual watcher, and only then "enabled" — meaning the
 * screen is empty because nothing has happened yet. A dashboard that cannot
 * tell those four apart sends people to read config files.
 */
export type WatcherStatus = 'disabled' | 'paused' | 'off' | 'enabled'

export function watcherStatus(
  lens: Recorder,
  enabled: boolean,
  watchers: WatcherConfig,
  watcher: string
): WatcherStatus {
  if (!enabled) return 'disabled'
  if (lens.isPaused()) return 'paused'

  const options = watchers[watcher]

  if (options === undefined || options === false) return 'off'
  if (options.enabled === false) return 'off'

  return 'enabled'
}

/** The watcher that feeds each entry type, for `status`. */
export const WATCHER_FOR: Partial<Record<EntryTypeName, string>> = {
  cache: 'cache',
  exception: 'exception',
  gate: 'gate',
  model: 'model',
  schedule: 'schedule',
  log: 'log',
  query: 'query',
  request: 'request'
}
