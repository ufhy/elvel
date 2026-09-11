import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records each view rendered, with what it cost.
 *
 * Telescope's `ViewWatcher` records the template path and the data passed to it.
 * The data is left out here for the reason it is left out of job payloads and
 * query bindings: a view's props are the page's contents, which is to say the
 * user's. What is recorded is the component, the size of the markup and how long
 * it took — enough to find the page that renders half a megabyte, which is the
 * question this screen exists for.
 */
export class ViewWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('view.rendered', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const view = String(payload.view ?? 'anonymous')

    if (this.option<string[]>('ignore', []).includes(view)) return

    lens.record(
      EntryType.VIEW,
      IncomingEntry.make({
        view,
        size: payload.size ?? 0,
        time: payload.durationMs ?? 0
      }).withTags([view])
    )
  }
}
