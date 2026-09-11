import type { ApplicationContract } from '@elvel/contracts'
import { refreshMonitoring, refreshPause } from '../pause.ts'
import type { Recorder } from '../recorder.ts'

/**
 * Give each console command a batch of its own. **Register before the watchers.**
 *
 * The third storage opportunity, and the last one missing: a command is a unit
 * of work like a request or a job, and without this everything one does — its
 * queries, its exceptions, the mail it sends — reached a recorder with no open
 * batch and was dropped.
 *
 * No `enterWorkContext()` here, unlike the HTTP plugin and the schedule
 * listener: `Kernel.execute()` already enters one before it dispatches
 * `command.starting`, for the deferred queue, and entering a second would
 * discard the first.
 */
export function openCommandBatches(app: ApplicationContract): void {
  app.make('events').listen('command.starting', () => {
    app.make('lens').start()
  })
}

/**
 * Store the command's batch. **Register after the watchers.**
 *
 * Split for the same reason the schedule listeners are: both this and
 * `CommandWatcher` subscribe to `command.finished`, listeners run in
 * registration order, and flushing before the watcher has recorded would store
 * an empty batch and drop the entry.
 */
export function flushCommandBatches(app: ApplicationContract): void {
  app.make('events').listen('command.finished', async () => {
    const lens: Recorder = app.make('lens')

    await lens.store(app.make('lens.entries'))
    await refreshPause(app, lens)
    await refreshMonitoring(app, lens)
  })
}
