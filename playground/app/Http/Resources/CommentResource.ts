import { JsonResource } from '@elyvel/http'
import type { Comment } from '../../Models/Comment.ts'

/** Generated with `bun run playground make:resource Comment`, then extended. */
export class CommentResource extends JsonResource<Comment> {
  toObject() {
    return {
      id: this.resource.id,
      author: this.resource.author,
      body: this.resource.body
    }
  }
}
