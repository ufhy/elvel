import type { ApplicationContract } from '@elvel/contracts'
import { QueryWatcher } from './query.ts'
import { RequestWatcher } from './request.ts'
import type { Watcher, WatcherOptions } from './watcher.ts'

/** Watcher name as it appears in `lens.watchers` to the class behind it. */
const WATCHERS: Record<string, new (options: WatcherOptions) => Watcher> = {
  query: QueryWatcher,
  request: RequestWatcher
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
 *
 * The instances come back because not every watcher has something to subscribe
 * to: `RequestWatcher` needs a `Response`, which only `onAfterResponse` holds,
 * so `lensPlugin` calls it directly. Returning what was constructed keeps that
 * lookup going through the same config that decides whether it exists at all.
 */
export function registerWatchers(
  app: ApplicationContract,
  config: WatcherConfig,
  report: (error: unknown) => void
): Watcher[] {
  const registered: Watcher[] = []

  for (const [name, options] of Object.entries(config)) {
    if (options === false) continue
    if (options.enabled === false) continue

    const watcher = WATCHERS[name]

    if (watcher === undefined) {
      report(new Error(`[lens] Unknown watcher [${name}] in lens.watchers.`))

      continue
    }

    const instance = new watcher(options)

    instance.register(app)
    registered.push(instance)
  }

  return registered
}

export { QueryWatcher } from './query.ts'
export { type RequestFacts, RequestWatcher } from './request.ts'
export { Watcher, type WatcherOptions } from './watcher.ts'
