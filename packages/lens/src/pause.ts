import type { ApplicationContract } from '@elvel/contracts'
import type { Recorder } from './recorder.ts'

/** Telescope's key, renamed. Shared so the commands and the refresh agree. */
export const PAUSE_KEY = 'lens:pause-recording'

/** Thirty days, as Telescope sets it — a forgotten pause should expire. */
export const PAUSE_TTL = 60 * 60 * 24 * 30

/**
 * What this needs from `@elvel/cache`, which is not a dependency of this package.
 *
 * Described rather than imported, the way `SessionRevocations` in `@elvel/auth`
 * describes the same manager: pausing is a convenience, and an application with
 * no cache at all should still be able to record. Resolved lazily too, since the
 * cache provider may boot after this one.
 */
export type CacheLike = {
  store(name?: string): {
    get<T = unknown>(key: string): Promise<T | null>
    put(key: string, value: unknown, ttl?: number): Promise<boolean>
    forget(key: string): Promise<boolean>
  }
}

/** The cache manager, or nothing when the application has none. */
export function cacheOf(app: ApplicationContract): CacheLike | undefined {
  if (!app.bound('cache' as never)) return undefined

  return app.make('cache' as never) as CacheLike
}

/**
 * Read the pause flag into the recorder.
 *
 * Called at boot and after each flush. Never throws and never stops recording: a
 * cache that is down should not silence a recorder, so a failure leaves the flag
 * as it was rather than assuming either answer. Telescope makes the same choice,
 * swallowing the exception around its own cache read.
 */
/**
 * Read the monitored tags into the recorder.
 *
 * Beside {@link refreshPause} because the two are the same shape: state that
 * lives outside the process, consulted by synchronous code, and therefore held
 * and refreshed rather than queried.
 */
export async function refreshMonitoring(app: ApplicationContract, lens: Recorder): Promise<void> {
  try {
    lens.setMonitoredTags(await app.make('lens.entries').monitoring())
  } catch {
    // Before the migration runs there is no table. Recording still works.
  }
}

export async function refreshPause(app: ApplicationContract, lens: Recorder): Promise<void> {
  const cache = cacheOf(app)

  if (cache === undefined) return

  try {
    lens.setPaused((await cache.store().get<boolean>(PAUSE_KEY)) === true)
  } catch {
    // Leave the flag alone.
  }
}
