import type { ApplicationContract } from '@elvel/contracts'
import { refreshMonitoring, refreshPause } from '../pause.ts'
import type { Recorder } from '../recorder.ts'

/** The event that starts a job. */
const STARTS = 'queue.job.processing'

/** The three that can end one. */
const ENDS = ['queue.job.processed', 'queue.job.released', 'queue.job.failed']

/**
 * Open a batch for each processed job. **Register before the watchers.**
 *
 * Telescope's second storage opportunity — `storeEntriesAfterWorkerLoop` — and
 * without it a queued job's work is recorded into nothing: the queries it runs,
 * the exceptions it reports and the messages it logs all reach a recorder with
 * no open batch. A worker is where a great deal of what anybody wants to see
 * actually happens.
 *
 * Telescope tracks a stack of in-flight jobs because a Laravel worker can be
 * processing a job that dispatches another synchronously. There is no stack
 * here: `Worker.process()` calls `enterWorkContext()` before it dispatches
 * `queue.job.processing`, so each job already has a context of its own and the
 * batch goes in that context's slot.
 */
export function openJobBatches(app: ApplicationContract): void {
  app.make('events').listen(STARTS, () => {
    app.make('lens').start()
  })
}

/**
 * Store the job's batch. **Register after the watchers.**
 *
 * Split from the opening for the reason the schedule listeners are split, and
 * found the same way — by running it. `JobWatcher` patches its entry on these
 * same events; with the flush registered first it stored an empty batch, marked
 * it flushed, and the patch that arrived a moment later went nowhere. The job
 * stayed `pending` forever while the worker reported success.
 */
export function flushJobBatches(app: ApplicationContract): void {
  app.make('events').listen(ENDS, async () => {
    const lens: Recorder = app.make('lens')

    await lens.store(app.make('lens.entries'))
    await refreshPause(app, lens)
    await refreshMonitoring(app, lens)
  })
}
