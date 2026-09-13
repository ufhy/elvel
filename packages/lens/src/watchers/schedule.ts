import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/** Every way a scheduled task can end, and the word for it. */
const OUTCOMES: Record<string, string> = {
  'schedule.task.finished': 'ran',
  'schedule.task.failed': 'failed',
  'schedule.task.skipped': 'skipped',
  'schedule.task.overlapping': 'overlapping'
}

/**
 * Records each scheduled task once it has finished, however it finished.
 *
 * Telescope hangs a `then()` callback on every event in the schedule when
 * `schedule:run` starts, because a scheduler with no per-task event gives nothing
 * else to listen for. Elvel's runner dispatches four — finished, failed, skipped and
 * overlapping — so this listens instead of reaching into the schedule, and gets
 * the two outcomes Telescope's approach cannot see: a task that was skipped, and
 * one that was refused because the last run had not finished.
 *
 * Those two are worth more than they sound. "The job did not run" and "the job
 * ran and failed" are different problems, and a recorder that only shows the
 * second sends people looking in the wrong place.
 */
export class ScheduleWatcher extends Watcher {
  register(app: ApplicationContract): void {
    for (const [event, outcome] of Object.entries(OUTCOMES)) {
      app.make('events').listen(event, (payload: Record<string, unknown>) => {
        this.record(app.make('lens'), outcome, payload)
      })
    }
  }

  private record(lens: Recorder, outcome: string, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const content: Record<string, unknown> = {
      task: String(payload.event ?? ''),
      outcome
    }

    if (typeof payload.reason === 'string') content.reason = payload.reason

    if (payload.error !== undefined && payload.error !== null) {
      content.error = payload.error instanceof Error ? payload.error.message : String(payload.error)
    }

    lens.record(EntryType.SCHEDULED_TASK, IncomingEntry.make(content))
  }
}
