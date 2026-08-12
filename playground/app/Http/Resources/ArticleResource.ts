import { JsonResource } from '@elysian/http'

export type ArticleShape = {
  id: number
  title: string
  status: string
  secret_notes?: string
  relationLoaded?: (name: string) => boolean
  comments?: Array<{ id: number; body: string }>
}

/** Generated with `bun run playground make:resource Article`, then extended. */
export class ArticleResource extends JsonResource<ArticleShape> {
  constructor(
    resource: ArticleShape,
    private readonly viewerIsEditor = false
  ) {
    super(resource)
  }

  toObject() {
    return {
      id: this.resource.id,
      title: this.resource.title,
      // Absent rather than null when the viewer may not see it.
      notes: this.when(this.viewerIsEditor, () => this.resource.secret_notes),
      // Never triggers a lazy load.
      comments: this.whenLoaded('comments'),
      links: this.merge({ self: `/articles/${this.resource.id}` })
    }
  }
}
