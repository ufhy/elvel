import type { ApplicationContract } from '@elvel/contracts'
import { QueryWatcher } from './query.ts'
import type { Watcher, WatcherOptions } from './watcher.ts'

/** Watcher name as it appears in `lens.watchers` to the class behind it. */
const WATCHERS: Record<string, new (options: WatcherOptions) => Watcher> = {
  query: QueryWatcher
}

/** Each entry is `false`, or its options with an optional `enabled`. */
export type WatcherConfig = Record<string, false | (WatcherOptions & { enabled?: boolean })>

/**
 * Construct and register the configured watchers.
 *
 * A watcher that is off is never constructed, so it costs nothing at all rather
 * than costing a subscription whose handler returns early. An unknown name is
 * reported rather than ignored — a typo in `lens.watchers` would otherwise read
 * as a watcher that silently records nothing.
 */
export function registerWatchers(
  app: ApplicationContract,
  config: WatcherConfig,
  report: (error: unknown) => void
): string[] {
  const registered: string[] = []

  for (const [name, options] of Object.entries(config)) {
    if (options === false) continue
    if (options.enabled === false) continue

    const watcher = WATCHERS[name]

    if (watcher === undefined) {
      report(new Error(`[lens] Unknown watcher [${name}] in lens.watchers.`))

      continue
    }

    new watcher(options).register(app)

    registered.push(name)
  }

  return registered
}

export { QueryWatcher } from './query.ts'
export { Watcher, type WatcherOptions } from './watcher.ts'
