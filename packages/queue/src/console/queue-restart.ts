import { Command } from '@elvel/console'

/** The cache key every worker watches. */
export const RESTART_KEY = 'elvel:queue:restart'

/**
 * `queue:restart` — tell every worker to finish its job and exit.
 *
 * A worker is a long-lived process holding the code that was current when it
 * started, so a deploy that does not restart them leaves the old code running
 * against the new database. This broadcasts a timestamp; each worker compares it
 * against the one it started with, finishes the job in hand, and exits for the
 * supervisor to start again.
 *
 * It signals rather than kills, and that distinction is the whole feature:
 * killing a worker mid-job leaves the job reserved until its reservation
 * expires, which on a queue with a long `retryAfter` is a job that appears to
 * have vanished.
 */
export class QueueRestartCommand extends Command {
  static override signature = 'queue:restart'

  static override description = 'Ask every queue worker to restart after its current job'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('queue:restart needs a cache store — that is where the signal lives.')

      return 1
    }

    // Forever: a worker started next week must still see a signal from today as
    // "newer than when I started", and an expiring key would make it invisible.
    await this.app.make('cache').store().forever(RESTART_KEY, Date.now())

    this.output.tag('INFO', 'Broadcasting queue restart signal.')

    return 0
  }
}
