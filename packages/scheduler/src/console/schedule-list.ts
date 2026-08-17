import { Command } from '@elyvel/console'

/** `schedule:list` — what is registered, and when each entry next runs. */
export class ScheduleListCommand extends Command {
  static override signature = 'schedule:list {--timezone= : Show next run times in this zone}'

  static override description = 'List the scheduled commands'

  async handle(): Promise<number> {
    const events = this.app.make('schedule').events()

    if (events.length === 0) {
      this.comment('No scheduled commands have been registered.')

      return 0
    }

    const zone = this.stringOption('timezone')

    this.output.table(
      ['EXPRESSION', 'TASK', 'NEXT RUN'],
      events.map((event) => {
        const next = event.nextRunAt()

        return [
          event.cronExpression,
          event.describedAs ?? event.label,
          zone === ''
            ? next.toISOString().slice(0, 16).replace('T', ' ')
            : next.toLocaleString('en-GB', { timeZone: zone, hour12: false })
        ]
      })
    )

    return 0
  }
}
