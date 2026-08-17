import type { ConnectionManager } from '@elvel/database'
import { identify, type Notifiable } from '../notifiable.ts'
import type { AnyNotification } from '../notification.ts'

export type DatabaseChannelOptions = {
  connection?: string
  table?: string
}

/**
 * Stores the notification — Laravel's `DatabaseChannel`.
 *
 * This is what an in-app inbox reads. The payload comes from `toDatabase()` or
 * `toArray()`, and the row carries the notifiable's type and key so one table
 * serves every kind of recipient.
 */
export class DatabaseNotificationChannel {
  readonly name = 'database'

  constructor(
    private readonly db: ConnectionManager,
    private readonly options: DatabaseChannelOptions = {}
  ) {}

  async send(notifiable: Notifiable, notification: AnyNotification): Promise<unknown> {
    const payload = notification.toDatabase?.(notifiable) ?? notification.toArray?.(notifiable)

    if (!payload) {
      throw new Error(
        `Notification [${notification.constructor.name}] lists the database channel but has neither toDatabase() nor toArray().`
      )
    }

    const { type, id } = identify(notifiable)

    if (id === null || id === undefined) {
      throw new Error(
        `Notification [${notification.constructor.name}] cannot be stored: the recipient has no key. The database channel needs a saved model.`
      )
    }

    const row = {
      id: notification.id,
      type: notification.databaseType(),
      notifiable_type: type,
      notifiable_id: String(id),
      data: JSON.stringify(payload),
      read_at: null,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    }

    await (await this.query()).insert(row)

    return row
  }

  private async query() {
    return this.db.table(this.options.table ?? 'notifications', this.options.connection)
  }
}
