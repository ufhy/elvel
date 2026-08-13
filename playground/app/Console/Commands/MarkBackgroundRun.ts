import { cache } from '@elysian/cache'
import { Command } from '@elysian/console'

/**
 * Generated with `artisan make:command MarkBackgroundRun`, then extended.
 *
 * Writes its own process id into the cache. That is what makes a forked
 * scheduled entry provable: if the pid it records differs from the scheduler's,
 * the task really did run in a child process rather than inline.
 */
export class MarkBackgroundRun extends Command {
  static override signature =
    'demo:mark-run {key=background : Cache key to write} {--fail : Exit non-zero, to drive the failure path}'

  static override description = 'Record the pid this ran in, for the scheduler smoke test'

  async handle(): Promise<number> {
    await cache().put(`schedule:${this.argument('key')}`, { pid: process.pid }, 300)

    return this.flag('fail') ? 1 : 0
  }
}
