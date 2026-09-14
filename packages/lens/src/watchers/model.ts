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
 * of an `eloquent.*` wildcard. Listening per action rather than to `*` matters:
 * `*` would also catch `cache.hit`, `db.query` and every application event, and
 * a recorder that catches its own writes does not stop.
 *
 * Telescope also counts hydrations, aggregating thousands of `retrieved` events
 * into one entry by mutating an entry already sitting in the queue. Elvel fires
 * no `retrieved` event, so there is nothing to count — see the note in
 * `BEHAVIOURS.md` territory rather than a silent absence here.
 *
 * **What a cast kept out of storage stays out of here.** An `encrypted` column
 * holds ciphertext precisely so the value is not readable at rest, and this
 * watcher was writing the plaintext into an entry anyone who can open the
 * dashboard could read. `QueryWatcher` already refuses to record bindings for
 * the same reason; this is that rule applied to the values it declined.
 */
export class ModelWatcher extends Watcher {
  register(app: ApplicationContract): void {
    const events = app.make('events')

    for (const action of ACTIONS) {
      /**
       * A wildcard listener is handed the resolved name first and the payload
       * second — `listener(eventKey, payload)`. Getting
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
      constructor?: { name?: string; casts?: Record<string, unknown>; hidden?: string[] }
      id?: unknown
      getChanges?(): Record<string, unknown>
    }

    const name = model.constructor?.name ?? 'Model'

    if (this.ignored(name)) return

    const changes = typeof model.getChanges === 'function' ? model.getChanges() : undefined
    const masked = changes === undefined ? undefined : this.mask(changes, model.constructor ?? {})

    lens.record(
      EntryType.MODEL,
      IncomingEntry.make({
        action,
        model: model.id === undefined ? name : `${name}:${String(model.id)}`,
        changes: masked === undefined || Object.keys(masked).length === 0 ? null : masked
      }).withTags([name])
    )
  }

  /**
   * The changes, with the values that are nobody's business replaced.
   *
   * Three sources, and none of them has to be maintained here: a cast that
   * encrypts or hashes says the value is not to be stored readable, the model's
   * own `hidden` says it is not to be shown, and `hidden` on this watcher is for
   * the column that is neither but is still a secret. The key is kept — that an
   * attribute changed is the useful half, and it is not the sensitive half.
   */
  private mask(
    changes: Record<string, unknown>,
    model: { casts?: Record<string, unknown>; hidden?: string[] }
  ): Record<string, unknown> {
    const casts = model.casts ?? {}
    const hidden = new Set([...(model.hidden ?? []), ...this.option<string[]>('hidden', [])])
    const result: Record<string, unknown> = {}

    for (const [attribute, value] of Object.entries(changes)) {
      const cast = String(casts[attribute] ?? '')
      const secret = cast.startsWith('encrypted') || cast === 'hashed' || hidden.has(attribute)

      result[attribute] = secret ? '********' : value
    }

    return result
  }

  private ignored(name: string): boolean {
    return this.option<string[]>('ignore', []).includes(name)
  }
}
