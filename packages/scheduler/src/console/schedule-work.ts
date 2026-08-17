import { Command } from '@elyvel/console'
import { INTERRUPT_KEY, PAUSE_KEY } from './schedule-interrupt.ts'

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

    /**
     * The signal as it stood at start-up, as `queue:work` reads its restart.
     *
     * Compared against the value from *now*, a runner started after somebody
     * interrupted would quit immediately and the supervisor would loop.
     */
    const startedWith = await this.signal(INTERRUPT_KEY)

    while (!stopping) {
      if (await this.paused()) {
        // Skipped, not queued: a missed run is missed, exactly as it is when
        // cron itself is stopped. Catching up would run an hour of entries at
        // once the moment somebody resumed.
        if (!this.flag('run-output-only')) this.comment('Paused — nothing ran this minute.')
      } else {
        await this.call('schedule:run', this.flag('run-output-only') ? ['--quiet-when-empty'] : [])
      }

      if ((await this.signal(INTERRUPT_KEY)) !== startedWith) {
        this.info('Interrupted. Stopping after this minute.')
        break
      }

      if (stopping) break

      // Sleep to the start of the next minute, not for a whole minute: drifting
      // by a second per iteration would eventually miss an entry.
      const now = new Date()
      const untilNextMinute = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds())

      await Bun.sleep(untilNextMinute)
    }

    return 0
  }

  /** The timestamp `schedule:interrupt` writes, or undefined without a cache. */
  private async signal(key: string): Promise<number | undefined> {
    if (!this.app.bound('cache')) return undefined

    return (await this.app.make('cache').store().get<number>(key)) ?? undefined
  }

  private async paused(): Promise<boolean> {
    if (!this.app.bound('cache')) return false

    return (await this.app.make('cache').store().get<boolean>(PAUSE_KEY)) === true
  }
}
