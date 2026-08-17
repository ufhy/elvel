import { Command } from '@elvel/console'

/**
 * `queue:clear`
 *
 * Deletes *pending* work, which is not something to do by accident — hence the
 * confirmation in production.
 */
export class QueueClearCommand extends Command {
  static override signature =
    'queue:clear {connection? : The connection to clear} {--queue= : The queue to clear} {--force : Clear without confirming in production}'

  static override description = 'Delete all of the jobs from the specified queue'

  async handle(): Promise<number> {
    if (this.app.isProduction() && !this.flag('force')) {
      this.error('Refusing to clear a queue in production without --force.')
      return 1
    }

    const manager = this.app.make('queue')
    const connection = this.argument('connection') || undefined
    const driver = manager.connection(connection)

    const queue = this.stringOption('queue') || driver.defaultQueue
    const cleared = await driver.clear(queue)

    this.output.tag('INFO', `Deleted ${cleared} job(s) from [${queue}].`)

    return 0
  }
}
