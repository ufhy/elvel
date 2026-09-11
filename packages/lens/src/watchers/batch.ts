import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records a queue batch when it is dispatched.
 *
 * A batch entry is a handle rather than a record: it names the batch and says
 * how many jobs went into it, and the jobs themselves carry the same id, so the
 * dashboard can go from one to the other by tag.
 *
 * What it does **not** do is track completion. Telescope patches its batch entry
 * from the job watcher, reading `BatchRepository` on every job that finishes —
 * a read per job to keep a counter that the batches table already holds. Asking
 * that table is the better answer, and it is a screen rather than a recorder's
 * job.
 */
export class BatchWatcher extends Watcher {
  register(app: ApplicationContract): void {
    app.make('events').listen('queue.batch.dispatched', (payload: Record<string, unknown>) => {
      this.record(app.make('lens'), payload)
    })
  }

  private record(lens: Recorder, payload: Record<string, unknown>): void {
    if (!lens.recording()) return

    const id = typeof payload.batchId === 'string' ? payload.batchId : undefined

    if (id === undefined) return

    lens.record(
      EntryType.BATCH,
      IncomingEntry.make({
        batch: id,
        name: payload.name ?? null,
        totalJobs: payload.totalJobs ?? 0,
        queue: payload.queue ?? null,
        connection: payload.connection ?? null
      }).withTags([`batch:${id}`])
    )
  }
}
