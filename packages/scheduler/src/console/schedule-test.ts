import { Command } from '@elvel/console'
import { ScheduleRunner } from '../runner.ts'

/**
 * `schedule:test`
 *
 * Run one entry now, whatever its expression says. The point is to find out
 * whether the task works before waiting for its window — so the cron expression
 * and the `when`/`skip` filters are both bypassed.
 */
export class ScheduleTestCommand extends Command {
  static override signature =
    'schedule:test {name? : Name or description of the entry to run} {--all : Run every entry}'

  static override description = 'Run a scheduled command immediately'

  async handle(): Promise<number> {
    const events = this.app.make('schedule').events()

    if (events.length === 0) {
      this.comment('No scheduled commands have been registered.')
      return 0
    }

    const name = this.argument('name')

    const chosen = this.flag('all')
      ? events
      : events.filter(
          (event) => event.label === name || event.describedAs === name || event.summary === name
        )

    if (chosen.length === 0) {
      this.error(`No scheduled entry matches [${name}].`)
      this.comment(`Registered: ${events.map((event) => event.label).join(', ')}`)

      return 1
    }

    const runner = new ScheduleRunner({
      mutex: this.app.bound('cache') ? this.app.make('cache').store() : undefined,
      report: (error: unknown) => this.app.make('exception.handler').report(error)
    })

    let failures = 0

    for (const event of chosen) {
      this.info(`Running [${event.label}]`)

      // `runEvent` still honours the mutexes: a test run that trampled a live one
      // would be worse than waiting.
      const outcome = await runner.runEvent(event)

      if (outcome === 'failed') {
        failures += 1
        this.error(`  failed: ${String(event.error)}`)
      } else {
        this.output.tag('DONE', outcome)
      }
    }

    return failures > 0 ? 1 : 0
  }
}
