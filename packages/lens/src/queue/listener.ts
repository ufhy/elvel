import type { ApplicationContract } from '@elvel/contracts'
import { refreshMonitoring, refreshPause } from '../pause.ts'
import type { Recorder } from '../recorder.ts'

/** The event that starts a job, and the three that can end one. */
const STARTS = 'queue.job.processing'
const ENDS = ['queue.job.processed', 'queue.job.released', 'queue.job.failed']

/**
 * Give each processed job a batch of its own.
 *
 * This is Telescope's second storage opportunity — `storeEntriesAfterWorkerLoop`
 * — and without it a queued job's work is recorded into nothing at all: the
 * queries it runs, the exceptions it reports and the messages it logs all reach
 * a recorder with no open batch and are dropped. A worker is where a great deal
 * of what anybody wants to see actually happens.
 *
 * Telescope tracks a stack of in-flight jobs because a Laravel worker can be
 * processing a job that dispatches another synchronously. There is no stack
 * here: `Worker.process()` calls `enterWorkContext()` before it dispatches
 * `queue.job.processing`, so each job already has a context of its own and the
 * batch goes in that context's slot. A nested `sync` job gets its own context
 * and its own batch rather than borrowing the outer one.
 *
 * The residual risk is a job that ends without any of the three terminal events,
 * whose batch is then never flushed and whose entries are lost. Nothing in the
 * worker takes that path today — every route out of `process()` dispatches one
 * of them — and closing it properly needs a hook the worker does not offer.
 */
export function listenForJobs(app: ApplicationContract): void {
  const events = app.make('events')

  events.listen(STARTS, () => {
    app.make('lens').start()
  })

  events.listen(ENDS, async () => {
    const lens: Recorder = app.make('lens')

    await lens.store(app.make('lens.entries'))
    await refreshPause(app, lens)
    await refreshMonitoring(app, lens)
  })
}
