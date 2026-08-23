import { Command } from '@elvel/console'
import type { SessionDriver } from '../session.ts'

/**
 * `session:gc` — remove the sessions nobody is using any more.
 *
 * Every driver has implemented `gc()` from the start and nothing called it.
 * Measured in a demo after a few days of use: **over 130 files** in
 * `storage/framework/sessions`, and each one still a session that works. On the
 * file and database drivers nothing expires on its own, so "expired" is only true
 * once something acts on it.
 *
 * Scheduled hourly by the scaffold. The cache and redis drivers answer 0 because
 * their store expires keys itself, which is the honest answer rather than a
 * special case.
 */
export class SessionGcCommand extends Command {
  static override signature =
    'session:gc {--lifetime= : Seconds of inactivity to keep, overriding config}'

  static override description = 'Delete sessions that have been inactive past their lifetime'

  async handle(): Promise<number> {
    const configured = this.app.config.get<number>('session.lifetime', 7200)
    const given = this.stringOption('lifetime', '')
    const lifetime = given === '' ? configured : Number(given)

    if (!Number.isFinite(lifetime) || lifetime <= 0) {
      this.error(`[${given}] is not a number of seconds.`)

      return 1
    }

    const driver = this.app.make('session.driver') as SessionDriver
    const removed = await driver.gc(lifetime)

    /**
     * The number, and the lifetime it was measured against.
     *
     * A bare `0` reads as "nothing to do" and as "the wrong lifetime" equally
     * well, and those need different fixes.
     */
    this.output.tag(
      'INFO',
      `Removed ${removed} session${removed === 1 ? '' : 's'} idle for more than ${lifetime}s.`
    )

    return 0
  }
}
