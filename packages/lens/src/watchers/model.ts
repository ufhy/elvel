import type { ApplicationContract } from '@elvel/contracts'
import { ModelEvent } from '@elvel/database'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** The actions worth a row. Telescope's list, minus the `*ing` halves. */
const ACTIONS = ['created', 'updated', 'deleted', 'restored']

/**
 * Records what happened to a model, and what changed.
 *
 * Elvel names a model event `<model>.<action>` — `user.created`,
 * `article.updated` — which is what makes a wildcard per action the equivalent
 * of Laravel's `eloquent.*`. Listening per action rather than to `*` matters:
 * `*` would also catch `cache.hit`, `db.query` and every application event, and
 * a recorder that catches its own writes does not stop.
 *
 * Telescope also counts hydrations, aggregating thousands of `retrieved` events
 * into one entry by mutating an entry already sitting in the queue. Elvel fires
 * no `retrieved` event, so there is nothing to count — see the note in
 * `BEHAVIOURS.md` territory rather than a silent absence here.
 */
export class ModelWatcher extends Watcher {
  register(app: ApplicationContract): void {
    const events = app.make('events')

    for (const action of ACTIONS) {
      /**
       * A wildcard listener is handed the resolved name first and the payload
       * second — `listener(eventKey, payload)`, the way Laravel does it. Getting
       * that backwards recorded nothing at all and looked like a matching
       * problem.
       */
      events.listen(`*.${action}`, (_name: string, event: unknown) => {
        this.record(app.make('lens'), action, event)
      })
    }
  }

  private record(lens: Recorder, action: string, event: unknown): void {
    if (!lens.recording()) return
    if (!(event instanceof ModelEvent)) return

    const model = event.model as unknown as {
      constructor?: { name?: string }
      id?: unknown
      getChanges?(): Record<string, unknown>
    }

    const name = model.constructor?.name ?? 'Model'

    if (this.ignored(name)) return

    const changes = typeof model.getChanges === 'function' ? model.getChanges() : undefined

    lens.record(
      EntryType.MODEL,
      IncomingEntry.make({
        action,
        model: model.id === undefined ? name : `${name}:${String(model.id)}`,
        changes: changes === undefined || Object.keys(changes).length === 0 ? null : changes
      }).withTags([name])
    )
  }

  private ignored(name: string): boolean {
    return this.option<string[]>('ignore', []).includes(name)
  }
}
