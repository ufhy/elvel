import { cache } from '@elysian/cache'
import { Job } from '@elysian/queue'

/**
 * Generated with `artisan make:job ChainStep`, then extended.
 *
 * One step of one row, inside a batch of chains. Each step appends its name to
 * that row's record, so the order is readable afterwards — a chain that ran out
 * of order, or a step that never ran, both show up there rather than having to
 * be inferred from a count.
 */
export class ChainStep extends Job<{ row: number; step: string }> {
  static override tries = 1

  async handle(): Promise<void> {
    const key = `chain:row:${this.data.row}`
    const so_far = (await cache().get<string>(key)) ?? ''

    await cache().put(key, so_far === '' ? this.data.step : `${so_far},${this.data.step}`, 300)
  }
}
