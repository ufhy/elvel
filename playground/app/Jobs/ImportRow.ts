import { cache } from '@elysian/cache'
import { Job } from '@elysian/queue'

/**
 * Generated with `artisan make:job ImportRow`, then extended.
 *
 * One row of a batch. `fail: true` makes it throw, so the batch's failure path
 * can be driven from a route.
 */
export class ImportRow extends Job<{ row: number; fail?: boolean }> {
  static override tries = 1

  async handle(): Promise<void> {
    if (this.data.fail) throw new Error(`Row ${this.data.row} is malformed.`)

    await cache().put(`import:row:${this.data.row}`, 'done', 300)
  }
}
