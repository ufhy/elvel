import { Command } from '@elysian/console'

/** The cache key a running `schedule:work` watches. */
export const INTERRUPT_KEY = 'elysian:schedule:interrupt'

/** Where a pause is recorded. */
export const PAUSE_KEY = 'elysian:schedule:paused'

/**
 * `schedule:interrupt` — stop the current schedule run.
 *
 * The counterpart to `queue:restart`, and for the same reason: `schedule:work`
 * is a long-lived process holding code a deploy has replaced. It signals rather
 * than kills, so an entry in flight finishes instead of leaving a mutex held for
 * however long `withoutOverlapping` was given.
 */
export class ScheduleInterruptCommand extends Command {
  static override signature = 'schedule:interrupt'

  static override description = 'Interrupt the current schedule run'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('schedule:interrupt needs a cache store — that is where the signal lives.')

      return 1
    }

    await this.app.make('cache').store().forever(INTERRUPT_KEY, Date.now())

    this.output.tag('INFO', 'Broadcasting schedule interrupt signal.')

    return 0
  }
}

/**
 * `schedule:pause` — keep the runner up and let nothing fire.
 *
 * For a maintenance window: interrupting instead means the supervisor starts a
 * new runner a second later, and stopping the supervisor means remembering to
 * start it again. Paused, the loop keeps turning and every entry is skipped —
 * and a missed run is a missed run, not a queued one, exactly as cron behaves.
 */
export class SchedulePauseCommand extends Command {
  static override signature = 'schedule:pause'

  static override description = 'Stop the scheduler running anything, without stopping it'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('schedule:pause needs a cache store — that is where the flag lives.')

      return 1
    }

    await this.app.make('cache').store().forever(PAUSE_KEY, true)

    this.output.tag('INFO', 'Schedule paused. Nothing will fire until it is resumed.')
    this.comment('  Missed runs are missed, not queued — as they are when cron is stopped.')

    return 0
  }
}

/** `schedule:resume` — the other half. */
export class ScheduleResumeCommand extends Command {
  static override signature = 'schedule:resume'

  static override description = 'Let the scheduler run entries again'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('schedule:resume needs a cache store — that is where the flag lives.')

      return 1
    }

    await this.app.make('cache').store().forget(PAUSE_KEY)

    this.output.tag('INFO', 'Schedule resumed.')

    return 0
  }
}

/**
 * `schedule:clear-cache` — release mutexes a killed run left behind.
 *
 * `withoutOverlapping` holds a lock for as long as it was given, and a run that
 * was killed rather than stopped never releases it. Until it expires the entry
 * looks like it is still running and is skipped every minute — which reads as
 * "the scheduler stopped working" and is the one failure this command exists for.
 */
export class ScheduleClearCacheCommand extends Command {
  static override signature = 'schedule:clear-cache'

  static override description = 'Release the mutexes of scheduled entries'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('schedule:clear-cache needs a cache store — that is where the mutexes live.')

      return 1
    }

    const store = this.app.make('cache').store()
    const entries = this.app.make('schedule').events()
    let cleared = 0

    for (const event of entries) {
      for (const kind of ['overlap', 'one-server'] as const) {
        const key = `${event.mutexName()}:${kind}`

        if ((await store.get(key)) !== undefined && (await store.forget(key))) cleared += 1
      }
    }

    this.output.tag('INFO', `Released ${cleared} mutex(es) across ${entries.length} entr(ies).`)

    return 0
  }
}
