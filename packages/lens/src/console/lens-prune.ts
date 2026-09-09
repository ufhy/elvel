import { Command } from '@elvel/console'
import { isPrunable } from '../contracts.ts'

/**
 * `lens:prune`
 *
 * The only defence against unbounded growth, and it is deliberate rather than
 * automatic: sampling would decide for you which requests are interesting, and
 * the ones worth having are usually the rare ones. So everything is kept, for a
 * window, and this sets the window. Meant for the scheduler.
 */
export class LensPruneCommand extends Command {
  static override signature =
    'lens:prune {--hours=24 : Hours of entries to retain} {--keep-exceptions : Retain exceptions regardless of age}'

  static override description = 'Delete Lens entries older than the retention window'

  async handle(): Promise<number> {
    const repository = this.app.make('lens.entries')

    if (!isPrunable(repository)) {
      this.error('The configured Lens driver cannot prune.')

      return 1
    }

    const hours = Number(this.stringOption('hours') || '24')

    if (!Number.isFinite(hours) || hours < 0) {
      this.error('--hours must be a non-negative number.')

      return 1
    }

    const before = new Date(Date.now() - hours * 3_600_000)
    const pruned = await repository.prune(before, this.flag('keep-exceptions'))

    this.output.tag('INFO', `Pruned ${pruned} entr${pruned === 1 ? 'y' : 'ies'}.`)

    return 0
  }
}
