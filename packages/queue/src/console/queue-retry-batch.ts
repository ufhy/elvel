import { Command } from '@elyvel/console'

/**
 * `queue:retry-batch` — re-queue every failed job in one batch.
 *
 * A batch is the unit somebody actually thinks in: "the nightly import broke",
 * not "jobs 4102, 4109 and 4155 broke". The batch records which of its jobs
 * failed, so this is that list handed to the same retry path `queue:retry` uses
 * — and the batch's own failure count is left alone, since it is the history of
 * what happened rather than a live tally.
 */
export class QueueRetryBatchCommand extends Command {
  static override signature = 'queue:retry-batch {id : The batch id}'

  static override description = 'Retry the failed jobs of a batch'

  async handle(): Promise<number> {
    const manager = this.app.make('queue')
    const id = this.argument('id')

    const batch = await manager.batches().find(id)

    if (!batch) {
      this.error(`No batch with id [${id}].`)
      return 1
    }

    const ids = batch.failedJobIds

    if (ids.length === 0) {
      this.output.tag('INFO', `Batch [${id}] has no failed jobs.`)
      return 0
    }

    let requeued = 0
    const missing: string[] = []

    for (const jobId of ids) {
      // A failed record can have been flushed since; naming it beats a silent
      // count that is lower than the batch says it should be.
      if (await manager.retry(jobId)) requeued += 1
      else missing.push(jobId)
    }

    this.output.tag('INFO', `Re-queued ${requeued} of ${ids.length} failed job(s).`)

    if (missing.length > 0) {
      this.warn(`No failed record for: ${missing.join(', ')} (flushed already?)`)
    }

    return 0
  }
}
