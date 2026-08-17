import { Job } from '@elyvel/queue'
import type { Article } from '../Models/Article.ts'

/**
 * Generated with `bun run playground make:job TouchArticle`, then extended.
 *
 * Carries a *model*, which is the interesting part: the payload holds the key,
 * not the record, and the worker re-reads the row. So the job sees the row as it
 * is when it runs — and fails loudly if it has since been deleted, rather than
 * working on a stale copy.
 */
export class TouchArticle extends Job<{ article: Article; suffix: string }> {
  static override tries = 1

  async handle(): Promise<void> {
    const article = this.data.article

    article.title = `${article.title}${this.data.suffix}`

    await article.save()
  }
}
