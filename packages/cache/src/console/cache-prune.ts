import { Command } from '@elysian/console'
import { DatabaseStore } from '../stores/database.ts'

/**
 * `cache:prune`
 *
 * The database store has no background expiry: a row lives until something reads
 * it or this runs. The other drivers expire on their own, so this says there was
 * nothing to do rather than pretending to work.
 */
export class CachePruneCommand extends Command {
  static override signature = 'cache:prune {--store= : The store to prune}'

  static override description = 'Delete expired entries from the database cache store'

  async handle(): Promise<number> {
    const store = this.stringOption('store')
    const repository = this.app.make('cache').store(store === '' ? undefined : store)

    if (!(repository.store instanceof DatabaseStore)) {
      this.comment('This store expires its own entries; nothing to prune.')
      return 0
    }

    const pruned = await repository.store.prune()

    this.output.tag('INFO', `Pruned ${pruned} expired row(s).`)

    return 0
  }
}
