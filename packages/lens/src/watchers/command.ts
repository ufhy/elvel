import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records each console command, once it has finished.
 *
 * On `command.finished` rather than `command.starting`, because the exit code is
 * the thing anybody looks for — a list of commands that started says nothing.
 * The pair still matters: `command.starting` is where `listenForCommands` opens
 * the batch, so whatever the command did in between lands beside it.
 *
 * `ignore` exists because a recorder inside a long-running command records its
 * own reason for existing: `queue:work` and `schedule:work` never end, so their
 * batch never flushes and everything they saw is lost anyway. The published
 * config names those.
 */
export class CommandWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('command.finished', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, event: Record<string, unknown>): void {
    if (!lens.recording()) return

    const name = String(event.command ?? '')

    if (this.ignored(name)) return

    const exit = Number(event.exitCode ?? 0)

    lens.record(
      EntryType.COMMAND,
      IncomingEntry.make({
        command: name,
        exitCode: exit,
        status: exit === 0 ? 'ok' : 'failed',
        arguments: Array.isArray(event.arguments) ? event.arguments : [],
        duration: event.durationMs ?? null
      }).withTags(exit === 0 ? [] : ['failed'])
    )
  }

  private ignored(name: string): boolean {
    return this.option<string[]>('ignore', []).some((pattern) =>
      pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
    )
  }
}
