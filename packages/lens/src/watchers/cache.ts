import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** Elvel's four cache events, mapped to Telescope's four words. */
const KINDS: Record<string, string> = {
  'cache.hit': 'hit',
  'cache.missed': 'missed',
  'cache.written': 'set',
  'cache.forgotten': 'forget'
}

/** A glob with one trailing `*`, or an exact name. Telescope's `Str::is`. */
function matches(subject: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? subject.startsWith(pattern.slice(0, -1)) : subject === pattern
  )
}

/**
 * Records cache reads and writes.
 *
 * **The value is recorded**, for `hit` and `set`, which is what Telescope does
 * and therefore what this does. Say plainly what that means: whatever the
 * application caches ends up in a table, so a cached user record is a user
 * record in the recorder, and a cached token is a token. Telescope's answer is
 * the `hidden` option below, whose default is an empty list — and the gate,
 * which here refuses everyone until an application opens it.
 *
 * `ignore` drops an entry entirely; `hidden` keeps the entry and masks the
 * value. Both take a name or a `prefix*` glob.
 */
export class CacheWatcher extends Watcher {
  register(app: ApplicationContract): void {
    for (const [event, kind] of Object.entries(KINDS)) {
      app.make('events').listen(event, (payload: Record<string, unknown>) => {
        this.record(app.make('lens'), kind, payload)
      })
    }
  }

  private record(lens: Recorder, kind: string, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const key = String(payload.key ?? '')

    if (matches(key, this.option<string[]>('ignore', []))) return

    const content: Record<string, unknown> = { type: kind, key, store: payload.store ?? null }

    if (kind === 'hit' || kind === 'set') {
      content.value = matches(key, this.option<string[]>('hidden', []))
        ? '********'
        : (payload.value ?? null)
    }

    if (kind === 'set' && payload.seconds !== undefined) content.expiration = payload.seconds

    lens.record(EntryType.CACHE, IncomingEntry.make(content))
  }
}
