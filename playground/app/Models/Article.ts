import { Model } from '@elysian/database'
import { Comment } from './Comment.ts'
import { Tag } from './Tag.ts'

/**
 * Generated with `bun run playground make:model Article -m -f`, then extended.
 *
 * Exercised end to end by `scripts/smoke.ts`: casts, soft deletes, a scope, a
 * relation, eager loading and an accessor.
 */
export class Article extends Model {
  static override table = 'articles'

  /** Columns mass assignment accepts. Everything else is refused. */
  static override fillable = [
    'title',
    'slug',
    'body',
    'status',
    'featured',
    'meta',
    'published_at',
    'author_id',
    'editor_note'
  ]

  /** SQLite has no boolean and JSON arrives as text; casts hide both. */
  /**
   * `editor_note` is encrypted at rest: the column holds a ciphertext and the
   * attribute holds the text. Nothing can query by it, which is the trade.
   */
  static override casts = {
    featured: 'boolean',
    meta: 'json',
    editor_note: 'encrypted'
  } as never

  static override softDeletes = true

  static override appends = ['excerpt']

  declare id: number
  declare title: string
  declare slug: string
  declare body: string
  declare status: string
  declare featured: boolean
  declare meta: Record<string, unknown> | null
  /** better-auth's user ids are strings, so this column is one too. */
  declare author_id: string | null
  declare editor_note: string | null

  /**
   * Tags, through a pivot shared with every other taggable model.
   *
   * `withPivot('added_by')` reads the extra column back, and `withTimestamps()`
   * writes the pair on attach — both arrive on `article.tags[0].pivot`.
   */
  tags() {
    return this.morphToMany(Tag, 'taggable').withPivot('added_by').withTimestamps()
  }

  comments() {
    return this.hasMany(Comment)
  }

  /** Backs `article.excerpt`, which has no column of its own. */
  getExcerptAttribute(): string {
    const body = String(this.attributes.body ?? '')

    return body.length > 40 ? `${body.slice(0, 40)}…` : body
  }

  static scopePublished(query: { where(column: string, value: unknown): unknown }) {
    query.where('status', 'published')
  }
}
