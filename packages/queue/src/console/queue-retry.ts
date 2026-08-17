import { Command } from '@elvel/console'

/**
 * `queue:retry <id|all>`
 *
 * Re-queues from the recorded payload with the attempt count reset: whoever runs
 * this has decided the cause is fixed, and keeping the old count would fail the
 * job again immediately.
 */
export class QueueRetryCommand extends Command {
  static override signature = 'queue:retry {id : A failed job id, or "all"}'

  static override description = 'Retry a failed queue job'

  async handle(): Promise<number> {
    const manager = this.app.make('queue')
    const id = this.argument('id')

    if (id === '') {
      this.error('An id, or "all", is required.')
      return 1
    }

    if (id === 'all') {
      const records = await manager.failed.all()

      for (const record of records) await manager.retry(record.id)

      this.output.tag('INFO', `Re-queued ${records.length} job(s).`)

      return 0
    }

    if (!(await manager.retry(id))) {
      this.error(`No failed job with id [${id}].`)
      return 1
    }

    this.output.tag('INFO', `Re-queued job [${id}].`)

    return 0
  }
}
