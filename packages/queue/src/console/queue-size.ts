import { Command } from '@elysian/console'

/** `queue:size` — how much work is waiting. */
export class QueueSizeCommand extends Command {
  static override signature =
    'queue:size {connection? : The connection to measure} {--queue= : The queue to measure}'

  static override description = 'Report the number of jobs on the queue'

  async handle(): Promise<number> {
    const manager = this.app.make('queue')
    const driver = manager.connection(this.argument('connection') || undefined)
    const queue = this.stringOption('queue') || driver.defaultQueue

    this.output.tag('INFO', `${await driver.size(queue)} job(s) on [${queue}].`)

    return 0
  }
}
