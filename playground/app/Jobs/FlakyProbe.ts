import { cache } from '@elyvel/cache'
import { Job } from '@elyvel/queue'

/**
 * Generated with `bun run playground make:job FlakyProbe`, then extended.
 *
 * Exists to exercise the retry policy quickly: two attempts, no backoff, so a
 * request can watch a job fail, be retried and land in the failed table without
 * waiting out a realistic delay. `SendArticleDigest` keeps the realistic one.
 */
export class FlakyProbe extends Job<{ label: string; failTimes: number }> {
  static override tries = 2

  /** Retried at once, which is what makes this observable in one request. */
  static override backoff = 0

  async handle(): Promise<void> {
    const log = (await cache().get<string[]>('digest:log')) ?? []

    await cache().forever('digest:log', [...log, `${this.data.label}:attempt-${this.attempts()}`])

    if (this.attempts() <= this.data.failTimes) {
      throw new Error(`Probe [${this.data.label}] failed on attempt ${this.attempts()}.`)
    }
  }

  override async failed(error: unknown): Promise<void> {
    const log = (await cache().get<string[]>('digest:log')) ?? []

    await cache().forever('digest:log', [
      ...log,
      `${this.data.label}:failed:${(error as Error).message.slice(0, 24)}`
    ])
  }
}
