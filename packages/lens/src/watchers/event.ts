import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Framework events, which the other watchers already cover properly.
 *
 * This is about **double recording**, not about a feedback loop. The loop —
 * `db.query` dispatched by the insert that stores an entry, recorded, stored,
 * dispatched again — is closed by `withoutRecording` around the flush, and a
 * test written here to demonstrate one passed with this list switched off. What
 * the list prevents is duller and real: a statement the application runs is
 * already a `query` entry, and a wildcard listener would file it as an `event`
 * row beside it, twice for every query in the request.
 *
 * The model patterns are here for the same reason — `ModelWatcher` records them
 * with the changes, which is strictly more useful than a row named
 * `user.updated`.
 */
const FRAMEWORK = [
  'db.*',
  'log.*',
  'cache.*',
  'gate.*',
  'queue.*',
  'schedule.*',
  'mail.*',
  'notification.*',
  'maintenance.*',
  // Each of these has a watcher of its own, and each was being filed twice: on a
  // page that runs no application event, the event menu showed nothing but the
  // duplicates.
  'http.client.*',
  'view.rendered',
  'dump.captured',
  'command.*',
  'redis.command*',
  '*.created',
  '*.creating',
  '*.updated',
  '*.updating',
  '*.deleted',
  '*.deleting',
  '*.restored',
  '*.saving',
  '*.saved'
]

/** A `*` at either end, or an exact name. Enough for the patterns above. */
function matches(name: string, pattern: string): boolean {
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1))
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))

  return name === pattern
}

/**
 * Records the application's own events.
 *
 * Telescope's `EventWatcher` listens to `*` and leans on
 * `Telescope::$ignoreFrameworkEvents` to stay useful; the same idea, with the
 * list written out because Elvel's framework events have no single prefix to
 * test for.
 *
 * One of Telescope's fields is missing: it names each registered listener, and
 * says whether the listener is queued. Elvel's dispatcher answers
 * `hasListeners` but does not expose the listeners themselves, so the field
 * would be a guess.
 */
export class EventWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('*', (name: string, payload: unknown) => {
      this.record(app.make('lens'), name, payload)
    })
  }

  private record(lens: Recorder, name: string, payload: unknown): void {
    if (!lens.recording()) return
    if (this.ignored(name)) return

    lens.record(
      EntryType.EVENT,
      IncomingEntry.make({
        name,
        payload: summarise(payload, 0)
      })
    )
  }

  private ignored(name: string): boolean {
    const configured = this.option<string[]>('ignore', [])
    const framework = this.option('ignoreFrameworkEvents', true) === true ? FRAMEWORK : []

    return [...framework, ...configured].some((pattern) => matches(name, pattern))
  }
}

/** How deep a payload is followed before it is named rather than described. */
const MAX_DEPTH = 3

/**
 * The payload, as data rather than as objects.
 *
 * `JSON.stringify` is not usable here: a payload commonly holds a model, a model
 * holds its relations, and a relation holds the model back — so a plain
 * serialisation either throws on the cycle or produces a row nobody wanted. This
 * walks to a fixed depth and names anything past it, which is also what keeps
 * one event from carrying an entire object graph into the table.
 */
function summarise(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return value

  const name = value.constructor?.name ?? 'Object'

  if (depth >= MAX_DEPTH) return `[${name}]`

  if (Array.isArray(value)) return value.map((entry) => summarise(entry, depth + 1))

  const described: Record<string, unknown> = {}

  for (const [key, held] of Object.entries(value)) {
    described[key] = summarise(held, depth + 1)
  }

  return name === 'Object' ? described : { class: name, properties: described }
}
