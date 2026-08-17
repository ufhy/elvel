import { Model } from '@elyvel/database'
import { Article } from './Article.ts'

/** Generated with `bun run playground make:model Comment -m`, then extended. */
export class Comment extends Model {
  static override table = 'comments'
  static override fillable = ['article_id', 'author', 'body']

  declare id: number
  declare article_id: number
  declare author: string
  declare body: string

  article() {
    return this.belongsTo(Article)
  }
}
