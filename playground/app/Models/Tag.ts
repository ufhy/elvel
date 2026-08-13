import { Model } from '@elysian/database'
import { Article } from './Article.ts'

/** Generated with `artisan make:model Tag -m`, then extended. */
export class Tag extends Model {
  static override fillable = ['label']

  declare id: number
  declare label: string

  /**
   * The inverse side of the polymorphic many-to-many.
   *
   * The pivot's type column names the *articles*, not this tag — getting that
   * backwards returns nothing at all, silently.
   */
  articles() {
    return this.morphedByMany(Article, 'taggable').withPivot('added_by')
  }
}
