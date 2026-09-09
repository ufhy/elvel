import type { ApplicationContract } from '@elvel/contracts'
import { callerFrom } from '../caller.ts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records every authorisation check and how it answered.
 *
 * The reason this earns its own entry type rather than being a log line: the
 * question people actually have is "why was this denied", and answering it needs
 * the ability, the arguments, the result, *and* the place that asked. A denial
 * with no file and line sends somebody grepping for the ability name.
 *
 * Arguments are summarised rather than serialised. A gate is usually handed the
 * model being authorised, and a model carries every column it loaded — recording
 * that would put rows of application data in a table for the sake of a boolean.
 * Telescope reduces a model to `Class:key` for the same reason.
 */
export class GateWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('gate.evaluated', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const ability = String(payload.ability ?? '')

    if (this.ignored(ability)) return

    const caller = callerFrom(new Error().stack, this.option<string[]>('ignorePaths', []))
    const user = payload.user as { id?: unknown } | null | undefined

    lens.record(
      EntryType.GATE,
      IncomingEntry.make({
        ability,
        result: payload.result === true ? 'allowed' : 'denied',
        arguments: summarise(payload.arguments),
        user: user?.id ?? null,
        file: caller?.file ?? null,
        line: caller?.line ?? null
      })
    )
  }

  private ignored(ability: string): boolean {
    return this.option<string[]>('ignoreAbilities', []).some((pattern) =>
      pattern.endsWith('*') ? ability.startsWith(pattern.slice(0, -1)) : ability === pattern
    )
  }
}

/**
 * Enough of each argument to recognise it, and no more.
 *
 * A primitive is itself. Anything with an `id` is named by its constructor and
 * that id, which is Telescope's `Class:key`. Everything else is named by its
 * constructor alone — a shape rather than its contents.
 */
function summarise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarise)
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value

  const name = value.constructor?.name ?? 'Object'
  const id = (value as { id?: unknown }).id

  return id === undefined ? name : `${name}:${String(id)}`
}
