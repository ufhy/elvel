import { Model } from '@elvel/database'
import { Article } from './Article.ts'

/** Generated with `bun run playground make:model Comment -m`, then extended. */
export class Comment extends Model {
  static override table = 'comments'
  static override fillable = ['article_id', 'author', 'body']

  declare id: number
  declare article_id: number
  declare author: string
  declare body: string

  /**
   * What `model:prune` may delete — anything left by the author `spam`.
   *
   * Declared here because the command reads `prunable()` off models **on disk**,
   * so an application is the only place it can be exercised at all. Until this
   * existed the command was broken outright: `{--model=*}` was read as a default
   * of `"*"`, every model was filtered out, and it reported
   * `No model defines prunable()` — see `playground/test/console.test.ts`.
   */
  static override prunable() {
    return Comment.query().where('author', 'spam')
  }

  article() {
    return this.belongsTo(Article)
  }
}
