import type { ApplicationContract } from '@elvel/contracts'
import { CacheWatcher } from './cache.ts'
import { CommandWatcher } from './command.ts'
import { EventWatcher } from './event.ts'
import { ExceptionWatcher } from './exception.ts'
import { GateWatcher } from './gate.ts'
import { JobWatcher } from './job.ts'
import { LogWatcher } from './log.ts'
import { MailWatcher } from './mail.ts'
import { ModelWatcher } from './model.ts'
import { NotificationWatcher } from './notification.ts'
import { QueryWatcher } from './query.ts'
import { RequestWatcher } from './request.ts'
import { ScheduleWatcher } from './schedule.ts'
import type { Watcher, WatcherOptions } from './watcher.ts'

/** Watcher name as it appears in `lens.watchers` to the class behind it. */
const WATCHERS: Record<string, new (options: WatcherOptions) => Watcher> = {
  cache: CacheWatcher,
  command: CommandWatcher,
  event: EventWatcher,
  exception: ExceptionWatcher,
  gate: GateWatcher,
  job: JobWatcher,
  log: LogWatcher,
  mail: MailWatcher,
  model: ModelWatcher,
  notification: NotificationWatcher,
  query: QueryWatcher,
  request: RequestWatcher,
  schedule: ScheduleWatcher
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

export { CacheWatcher } from './cache.ts'
export { CommandWatcher } from './command.ts'
export { EventWatcher } from './event.ts'
export { ExceptionWatcher } from './exception.ts'
export { GateWatcher } from './gate.ts'
export { JobWatcher } from './job.ts'
export { LogWatcher } from './log.ts'
export { MailWatcher } from './mail.ts'
export { ModelWatcher } from './model.ts'
export { NotificationWatcher } from './notification.ts'
export { QueryWatcher } from './query.ts'
export { type RequestFacts, RequestWatcher } from './request.ts'
export { ScheduleWatcher } from './schedule.ts'
export { Watcher, type WatcherOptions } from './watcher.ts'
