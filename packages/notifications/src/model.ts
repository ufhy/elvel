import { Model } from '@elvel/database'

/**
 * A stored notification — Laravel's `DatabaseNotification`.
 *
 * A model rather than a plain row so `unread()` is a query the database runs, not
 * a filter over everything ever stored.
 */
export class DatabaseNotification extends Model {
  static override table = 'notifications'

  /** The key is a uuid the sender generated, not an auto-increment. */
  static override incrementing = false

  static override keyType = 'string' as const

  static override fillable = ['id', 'type', 'notifiable_type', 'notifiable_id', 'data', 'read_at']

  static override casts = { data: 'json' } as never

  declare id: string
  declare type: string
  declare notifiable_type: string
  declare notifiable_id: string
  declare data: Record<string, unknown>
  declare read_at: Date | null

  /** Unread only. */
  static scopeUnread(query: { whereNull(column: string): unknown }) {
    query.whereNull('read_at')
  }

  static scopeRead(query: { whereNotNull(column: string): unknown }) {
    query.whereNotNull('read_at')
  }

  isRead(): boolean {
    return this.attributes.read_at !== null && this.attributes.read_at !== undefined
  }

  isUnread(): boolean {
    return !this.isRead()
  }

  /** Idempotent: marking a read notification again does not move its timestamp. */
  async markAsRead(): Promise<this> {
    if (this.isRead()) return this

    this.read_at = new Date()
    await this.save()

    return this
  }

  async markAsUnread(): Promise<this> {
    if (this.isUnread()) return this

    this.read_at = null
    await this.save()

    return this
  }
}
