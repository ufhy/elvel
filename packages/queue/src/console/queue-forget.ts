import { Command } from '@elvel/console'

/** `queue:forget <id>` — drop one failed job without retrying it. */
export class QueueForgetCommand extends Command {
  static override signature = 'queue:forget {id : The failed job id}'

  static override description = 'Delete a failed queue job'

  async handle(): Promise<number> {
    const id = this.argument('id')
    if (id === '') {
      this.error('An id is required.')
      return 1
    }

    if (!(await this.app.make('queue').failed.forget(id))) {
      this.error(`No failed job with id [${id}].`)
      return 1
    }

    this.output.tag('INFO', `Deleted failed job [${id}].`)

    return 0
  }
}
