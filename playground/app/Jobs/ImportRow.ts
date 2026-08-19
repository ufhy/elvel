import { cache } from '@elvel/cache'
import { Job } from '@elvel/queue'

/**
 * Generated with `elvel make:job ImportRow`, then extended.
 *
 * One row of a batch. `fail: true` makes it throw, so the batch's failure path
 * can be driven from a route.
 */
export class ImportRow extends Job<{ row: number; fail?: boolean; abort?: boolean }> {
  static override tries = 1

  async handle(): Promise<void> {
    if (this.data.fail) throw new Error(`Row ${this.data.row} is malformed.`)

    /**
     * One row deciding the whole import is pointless.
     *
     * `abort` is what a malformed header or a deleted account looks like: the
     * remaining rows cannot succeed, and cancelling the batch from inside stops
     * them without reaching into the queue. Recorded first, so a test can see
     * the job read its own batch rather than guessed at it.
     */
    if (this.data.abort) {
      const batch = await this.batch()

      await cache().put(`import:aborted`, { total: batch?.totalJobs ?? 0 }, 300)
      await batch?.cancel()

      return
    }

    await cache().put(`import:row:${this.data.row}`, 'done', 300)
  }
}
