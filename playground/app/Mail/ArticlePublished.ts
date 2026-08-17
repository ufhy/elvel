import type { Content, Envelope } from '@elyvel/mail'
import { Mailable, viewContent } from '@elyvel/mail'
import { ArticlePublishedMail } from '../../resources/views/mail/article-published.tsx'

/**
 * Generated with `bun run playground make:mail ArticlePublished`, then extended.
 *
 * `data` is the only thing that travels when this is queued, so it holds the
 * article's fields rather than the model: a worker rendering the mail an hour
 * later should send what was published, not whatever the row says by then.
 */
export class ArticlePublished extends Mailable<{
  title: string
  excerpt: string
  articleId: number
}> {
  /** Queue name used when this mailable is queued. */
  static override queue = 'mail'

  envelope(): Envelope {
    return {
      subject: `Published: ${this.data.title}`,
      replyTo: 'editors@example.com',
      tags: ['article'],
      metadata: { articleId: String(this.data.articleId) }
    }
  }

  content(): Content {
    const url = `http://localhost:3000/check/articles/${this.data.articleId}`

    return viewContent(
      ArticlePublishedMail,
      { title: this.data.title, excerpt: this.data.excerpt, url },
      // A text part as well: some clients show it, and spam filters like it.
      `${this.data.title}\n\n${this.data.excerpt}\n\n${url}`
    )
  }
}
