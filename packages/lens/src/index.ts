/**
 * Lens — a recorder and a dashboard for what an Elvel application did.
 *
 * The shape follows Laravel Telescope, whose design was read closely before any
 * of this was written, with one structural departure: the entry queue lives in a
 * request slot rather than a static, because Bun serves many requests at once in
 * one process and a static queue would attribute one request's queries to
 * another. See `recorder.ts`.
 *
 * ```ts
 * // config/lens.ts is published with `elvel config:publish lens`
 * // then, in a provider:
 * lens().filter((entry) => local || entry.isSlowQuery())
 * ```
 */
import { app } from '@elvel/core'
import type { Recorder } from './recorder.ts'

export { type CallerFrame, callerFrom } from './caller.ts'
export { LensClearCommand } from './console/lens-clear.ts'
export { LensInstallCommand } from './console/lens-install.ts'
export { LensPauseCommand } from './console/lens-pause.ts'
export { LensPruneCommand } from './console/lens-prune.ts'
export { LensResumeCommand } from './console/lens-resume.ts'
export { LensTableCommand } from './console/lens-table.ts'
export {
  type ClearableRepository,
  type EntriesDriver,
  type EntriesRepository,
  isClearable,
  isPrunable,
  isTerminable,
  type PrunableRepository,
  type TerminableRepository
} from './contracts.ts'
export { type EntryContent, IncomingEntry } from './entry.ts'
export { EntryResult } from './entry-result.ts'
export { EntryType, type EntryTypeName, entryTypes } from './entry-type.ts'
export { EntryUpdate } from './entry-update.ts'
export { type LensPluginOptions, lensPlugin, pathMatches } from './http/plugin.ts'
export { atLeast, PRIORITIES } from './log-level.ts'
export { PAUSE_KEY, PAUSE_TTL, refreshMonitoring, refreshPause } from './pause.ts'
export { LensServiceProvider } from './provider.ts'
export { listenForJobs } from './queue/listener.ts'
export {
  type AfterStoringHook,
  type Batch,
  type EntryFilter,
  Recorder,
  type TagCallback
} from './recorder.ts'
export {
  DatabaseEntriesRepository,
  type DatabaseRepositoryOptions
} from './storage/database-repository.ts'
export { EntryQueryOptions } from './storage/query-options.ts'
export {
  CacheWatcher,
  EventWatcher,
  ExceptionWatcher,
  GateWatcher,
  LogWatcher,
  MailWatcher,
  ModelWatcher,
  NotificationWatcher,
  QueryWatcher,
  type RequestFacts,
  RequestWatcher,
  registerWatchers,
  Watcher,
  type WatcherConfig,
  type WatcherOptions
} from './watchers/index.ts'

/** The recorder, for registering filters and tag callbacks. */
export function lens(): Recorder {
  return app('lens')
}
