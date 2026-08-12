import { JsonResource } from '@elysian/http'
import type { Article } from '../../Models/Article.ts'
import type { Comment } from '../../Models/Comment.ts'
import { CommentResource } from './CommentResource.ts'

/** Generated with `bun run playground make:resource Article`, then extended. */
export class ArticleResource extends JsonResource<Article> {
  constructor(
    resource: Article,
    private readonly viewerIsEditor = false
  ) {
    super(resource)
  }

  toObject() {
    return {
      id: this.resource.id,
      title: this.resource.title,
      slug: this.resource.slug,
      // Casts at work: SQLite stores 0/1, the API returns a boolean.
      featured: this.resource.featured,
      meta: this.resource.meta,
      // An accessor with no column of its own.
      excerpt: (this.resource as unknown as { excerpt: string }).excerpt,
      // withCount('comments') put this on the model as a plain attribute.
      commentCount: this.whenNotNull(this.resource.attributes.comments_count),
      // Never triggers a lazy load: absent unless the relation was loaded, and
      // nested through its own resource when it is.
      comments: this.whenLoaded('comments', () =>
        CommentResource.collection(this.resource.getRelation('comments') as Iterable<Comment>)
      ),
      // Absent, not null, when the viewer may not see it.
      status: this.when(this.viewerIsEditor, () => this.resource.status),
      // Encrypted in the column, plain here, and only for an editor: encryption
      // protects the row at rest, the resource decides who is shown it.
      editorNote: this.when(this.viewerIsEditor, () => this.resource.editor_note),
      links: this.merge({ self: `/check/articles/${this.resource.id}` })
    }
  }
}
