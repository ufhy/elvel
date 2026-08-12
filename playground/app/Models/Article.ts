import { Model } from '@elysian/database'
import { Comment } from './Comment.ts'

/**
 * Generated with `bun run playground make:model Article -m -f`, then extended.
 *
 * Exercised end to end by `scripts/smoke.ts`: casts, soft deletes, a scope, a
 * relation, eager loading and an accessor.
 */
export class Article extends Model {
  static override table = 'articles'

  /** Columns mass assignment accepts. Everything else is refused. */
  static override fillable = ['title', 'slug', 'body', 'status', 'featured', 'meta', 'published_at']

  /** SQLite has no boolean and JSON arrives as text; casts hide both. */
  static override casts = { featured: 'boolean', meta: 'json' } as never

  static override softDeletes = true

  static override appends = ['excerpt']

  declare id: number
  declare title: string
  declare slug: string
  declare body: string
  declare status: string
  declare featured: boolean
  declare meta: Record<string, unknown> | null

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
