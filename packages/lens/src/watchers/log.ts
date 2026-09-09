import type { ApplicationContract } from '@elvel/contracts'
import { MessageLogged } from '@elvel/log'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import { atLeast } from '../log-level.ts'
import type { Recorder } from '../recorder.ts'
import { ExceptionWatcher } from './exception.ts'
import { Watcher } from './watcher.ts'

/**
 * Records log messages at or above a level.
 *
 * Shares `MessageLogged` with `ExceptionWatcher`, and the split is Telescope's:
 * a record describing an exception belongs to that watcher and is skipped here,
 * so one failure is one row rather than two.
 *
 * `level` defaults to `error` in the published config, as Telescope's does. A
 * recorder set to `debug` in a chatty application will out-grow every other
 * entry type combined, and the level is the dial for that.
 */
export class LogWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen(MessageLogged, (event: MessageLogged) => {
      this.record(app.make('lens'), event)
    })
  }

  private record(lens: Recorder, event: MessageLogged): void {
    if (!lens.recording()) return

    const context = event.context as Record<string, unknown>

    // Belongs to ExceptionWatcher.
    if (ExceptionWatcher.describesException(context)) return

    if (!atLeast(event.level, this.option('level', 'error'))) return

    lens.record(
      EntryType.LOG,
      IncomingEntry.make({
        level: event.level,
        message: interpolate(event.message, context),
        context,
        channel: event.channel
      })
    )
  }
}

/**
 * Replace `{key}` with the context value, as PSR-3 describes and Telescope does.
 *
 * Only scalars: an object in a placeholder would render as `[object Object]`,
 * which is worse than leaving the placeholder visible next to the context that
 * holds the real value.
 */
function interpolate(message: string, context: Record<string, unknown>): string {
  let interpolated = message

  for (const [key, value] of Object.entries(context)) {
    if (value === null || typeof value === 'object' || typeof value === 'function') continue

    interpolated = interpolated.replaceAll(`{${key}}`, String(value))
  }

  return interpolated
}
