import { Command } from '@elysian/console'

/**
 * `schedule:work`
 *
 * Runs the schedule every minute without a crontab, which is what a container
 * wants. It waits for the top of each minute rather than sleeping sixty seconds
 * from whenever it started, so entries fire on the minute as cron would.
 */
export class ScheduleWorkCommand extends Command {
  static override signature = 'schedule:work {--run-output-only : Only print what actually ran}'

  static override description = 'Run the schedule every minute, in the foreground'

  async handle(): Promise<number> {
    this.info('Running the schedule every minute. Press Ctrl+C to stop.')

    let stopping = false
    const stop = () => {
      stopping = true
      this.comment('Finishing the current minute, then stopping…')
    }

    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    while (!stopping) {
      await this.call('schedule:run', this.flag('run-output-only') ? ['--quiet-when-empty'] : [])

      if (stopping) break

      // Sleep to the start of the next minute, not for a whole minute: drifting
      // by a second per iteration would eventually miss an entry.
      const now = new Date()
      const untilNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds())

      await Bun.sleep(untilNextMinute)
    }

    return 0
  }
}
