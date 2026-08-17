import { cache } from '@elyvel/cache'
import { Job, queue } from '@elyvel/queue'

/**
 * A batch callback — dispatched by `then()` / `catch()` when the batch reaches
 * that outcome.
 *
 * A job rather than a closure: the worker that runs this is a different process
 * from the one that described the batch, and a closure cannot travel. The batch id
 * arrives in the data, so the callback can report on what it is reporting about.
 */
export class ReportImport extends Job<{ batchId: string }> {
  async handle(): Promise<void> {
    const batch = await queue().batches().find(this.data.batchId)

    await cache().put(
      `import:report:${this.data.batchId}`,
      {
        total: batch?.totalJobs ?? 0,
        failed: batch?.failedJobs ?? 0,
        progress: batch?.progress ?? 0
      },
      300
    )
  }
}
