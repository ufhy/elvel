import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** What `@elvel/redis` dispatches for every command it runs. */
type CommandEvent = {
  command?: unknown
  args?: unknown
  duration?: unknown
  connectionName?: unknown
  error?: unknown
}

/**
 * Records Redis commands and how long each took.
 *
 * A page whose slowest part was Redis showed the total and could not say where
 * any of it went: the cache watcher covers what goes through `@elvel/cache`,
 * and a queue pop, a broadcast publish or a command the application ran itself
 * were invisible.
 *
 * Requires `@elvel/redis` — the events come from its connections, and a client
 * built by hand dispatches nothing. `ignore` drops commands by name, which is
 * how a poll every few milliseconds stops being most of the timeline.
 */
export class RedisWatcher extends Watcher {
  register(app: ApplicationContract): void {
    const record = (failed: boolean) => (event: CommandEvent) => {
      this.record(app.make('lens'), event, failed)
    }

    app.make('events').listen('redis.command', record(false))
    app.make('events').listen('redis.command.failed', record(true))
  }

  private record(lens: Recorder, event: CommandEvent, failed: boolean): void {
    if (!lens.recording()) return

    const command = String(event.command ?? '').toUpperCase()

    if (this.option<string[]>('ignore', []).includes(command)) return

    const args = Array.isArray(event.args) ? event.args.map(String) : []

    lens.record(
      EntryType.REDIS,
      IncomingEntry.make({
        command: [command, ...args].join(' '),
        name: command,
        connection: String(event.connectionName ?? 'default'),
        time: Number(event.duration ?? 0),
        // A failure carries no duration — it never finished — so the message is
        // what there is to show.
        failed,
        error: failed ? errorMessage(event.error) : undefined
      })
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}
