import { cache } from '@elysian/cache'
import { Job, WithoutOverlapping } from '@elysian/queue'
import { Article } from '../Models/Article.ts'

/**
 * Generated with `bun run playground make:job SendArticleDigest`, then extended.
 *
 * Stands in for the usual reason to queue something: work that reads the
 * database, takes a moment, and nobody should wait for. What it actually does is
 * record what it saw in the cache, so a route can prove the worker ran.
 */
export class SendArticleDigest extends Job<{ label: string; failOnPurpose?: boolean }> {
  static override tries = 3

  /** Five seconds, then thirty, then two minutes for any attempt after. */
  static override backoff = [5, 30, 120]

  /** Only one digest at a time, whatever else is queued. */
  override middleware() {
    return [new WithoutOverlapping(cache(), 'digest', { releaseAfter: 5 })]
  }

  async handle(): Promise<void> {
    // Deliberate failure, to exercise retries and the failed-job table.
    if (this.data.failOnPurpose) {
      throw new Error(`Digest [${this.data.label}] was asked to fail.`)
    }

    const titles = (await Article.query().orderBy('id').get()).all().map((article) => article.title)

    const log = (await cache().get<string[]>('digest:log')) ?? []

    await cache().forever('digest:log', [
      ...log,
      `${this.data.label}:${titles.length}:attempt-${this.attempts()}`
    ])
  }

  /** Runs once, after the last attempt failed. */
  override async failed(error: unknown): Promise<void> {
    const log = (await cache().get<string[]>('digest:log')) ?? []

    await cache().forever('digest:log', [
      ...log,
      `${this.data.label}:failed:${(error as Error).message.slice(0, 30)}`
    ])
  }
}
