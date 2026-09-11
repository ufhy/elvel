import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records what `dump()` printed.
 *
 * Telescope's `DumpWatcher` is the one that only listens while somebody is
 * looking: it registers nothing unless `always` is set or the Dumps screen has
 * put `telescope:dump-watcher` in the cache. The reason is sound — a dump is
 * written to be read *now*, in the terminal, and filing every one of them
 * forever is a table of debugging somebody else already finished with.
 *
 * That is not copied, and the trade is different here. Elvel's `dump()` prints
 * to the terminal either way, so recording it costs a row and loses nothing; and
 * the screen-open handshake needs a cache round trip on a path that has none.
 * `enabled: false` in the published config is the same switch, made explicit.
 */
export class DumpWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('dump.captured', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const values = Array.isArray(payload.values) ? payload.values : []
    const origin = payload.origin as { file?: unknown; line?: unknown } | undefined

    lens.record(
      EntryType.DUMP,
      IncomingEntry.make({
        values: values.map((value) => {
          const one = value as { label?: unknown; text?: unknown }

          return { label: one.label ?? null, text: String(one.text ?? '') }
        }),
        file: origin?.file ?? null,
        line: origin?.line ?? null
      })
    )
  }
}
