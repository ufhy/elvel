import type { ApplicationContract } from '@elvel/contracts'
import { enterWorkContext } from '@elvel/core'
import { refreshMonitoring, refreshPause } from '../pause.ts'
import type { Recorder } from '../recorder.ts'

/**
 * Events that mean a task is about to be recorded.
 *
 * `starting` is the obvious one. `skipped` and `overlapping` are here because
 * they are dispatched *instead of* `starting` — the decision not to run is
 * taken first — so they are both the beginning and the end of their own tiny
 * unit of work.
 */
const OPENS = ['schedule.task.starting', 'schedule.task.skipped', 'schedule.task.overlapping']

/** Every way a task can end. */
const CLOSES = [
  'schedule.task.finished',
  'schedule.task.failed',
  'schedule.task.skipped',
  'schedule.task.overlapping'
]

/**
 * Open a batch for each scheduled task. **Register before the watchers.**
 *
 * Without this the schedule watcher is dead code, and it was: running
 * `elvel schedule:run` on the playground executed three tasks and recorded
 * nothing at all, because a scheduler tick is not a request and nothing had
 * opened a batch for it. Found by running it, not by reading it.
 *
 * `enterWorkContext()` for the same reason the HTTP plugin enters one: the
 * runner loops over its entries in a single frame, so without a fresh context
 * per task every task in a run would share one batch and the first flush would
 * close it for the rest.
 */
export function openScheduleBatches(app: ApplicationContract): void {
  app.make('events').listen(OPENS, () => {
    enterWorkContext()
    app.make('lens').start()
  })
}

/**
 * Store each task's batch. **Register after the watchers.**
 *
 * Two listeners rather than one because a listener cannot open a batch for a
 * watcher that already ran: listeners fire in registration order, and on
 * `skipped` the watcher is the first to hear about it. Opening at one end and
 * flushing at the other is what lets both see the same batch.
 */
export function flushScheduleBatches(app: ApplicationContract): void {
  app.make('events').listen(CLOSES, async () => {
    const lens: Recorder = app.make('lens')

    await lens.store(app.make('lens.entries'))
    await refreshPause(app, lens)
    await refreshMonitoring(app, lens)
  })
}
