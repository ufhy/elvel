import { Command } from '@elysian/console'
import { ScheduleRunner } from '../runner.ts'
import { spawner } from '../spawn.ts'

/**
 * `schedule:run`
 *
 * What a crontab entry calls once a minute. It runs whatever is due *in this
 * minute*, so it is the schedule's resolution — running it less often silently
 * drops entries, which is why the documented crontab line is every minute.
 */
export class ScheduleRunCommand extends Command {
  static override signature = 'schedule:run {--quiet-when-empty : Say nothing when nothing is due}'

  static override description = 'Run the scheduled commands that are due'

  async handle(): Promise<number> {
    const startedAt = new Date()
    const schedule = this.app.make('schedule')
    const due = schedule.dueEvents(startedAt)

    if (due.length === 0) {
      if (!this.flag('quiet-when-empty')) this.comment('No scheduled commands are ready to run.')

      return 0
    }

    const runner = new ScheduleRunner(this.runnerOptions())
    const result = await runner.run(due)

    for (const outcome of result.outcomes) {
      const label = `${outcome.event} (${outcome.durationMs}ms)`

      if (outcome.outcome === 'ran') this.output.tag('DONE', label)
      else if (outcome.outcome === 'background') this.output.tag('INFO', `${label} — in background`)
      else if (outcome.outcome === 'failed') this.error(`FAIL  ${label}`)
      else this.comment(`SKIP  ${label} — ${outcome.outcome}`)
    }

    // Sub-minute entries keep going until the minute is over.
    const repeated = await runner.repeat(due, startedAt)

    if (repeated.ran + repeated.failed > 0) {
      this.output.tag('INFO', `Repeated ${repeated.ran + repeated.failed} sub-minute run(s).`)
    }

    /**
     * Wait for the children before leaving.
     *
     * A process that exits while one is still going releases no overlap mutex
     * and fires no `onSuccess`, so the next minute finds the task apparently
     * still running and skips it — for as long as the mutex lives.
     */
    if (runner.backgroundCount > 0) {
      this.output.tag('INFO', `Waiting for ${runner.backgroundCount} background task(s).`)
      await runner.waitForBackground()
    }

    return result.failed > 0 ? 1 : 0
  }

  /** Mutex store and reporting, when the packages that provide them are here. */
  protected runnerOptions() {
    return {
      mutex: this.app.bound('cache') ? this.app.make('cache').store() : undefined,
      events: this.app.bound('events')
        ? (this.app.make('events' as never) as {
            dispatch(event: string, payload?: unknown): unknown
          })
        : undefined,
      report: (error: unknown) => this.app.make('exception.handler').report(error),
      // The runner asks once per run; `down` and `up` happen between runs.
      isDownForMaintenance: () => this.app.isDownForMaintenance(),
      spawn: spawner(this.app)
    }
  }
}
