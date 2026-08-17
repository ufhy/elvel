import { Command } from '@elvel/console'

/** `queue:failed` — what failed, and enough of why to act on it. */
export class QueueFailedCommand extends Command {
  static override signature = 'queue:failed'

  static override description = 'List the failed queue jobs'

  async handle(): Promise<number> {
    const records = await this.app.make('queue').failed.all()

    if (records.length === 0) {
      this.comment('No failed jobs.')
      return 0
    }

    this.output.table(
      ['ID', 'JOB', 'QUEUE', 'FAILED AT', 'ERROR'],
      records.map((record) => [
        String(record.id),
        record.payload.displayName,
        `${record.connection}:${record.queue}`,
        record.failedAt.toISOString().slice(0, 19).replace('T', ' '),
        // The first line only: the stack is in the record for whoever wants it.
        record.exception.split('\n')[0]?.slice(0, 60) ?? ''
      ])
    )

    return 0
  }
}
