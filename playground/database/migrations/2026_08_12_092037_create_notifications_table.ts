import { Migration, type MigrationContext } from '@elvel/database'

/**
 * The stored-notification table.
 *
 * One table serves every kind of recipient: `notifiable_type` and `notifiable_id`
 * say who a row belongs to. The primary key is the uuid the sender generated, so a
 * stored row and the mail about the same notification share an id.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('notifications', (table) => {
      table.string('id').primary()
      table.string('type')
      table.string('notifiable_type')
      table.string('notifiable_id')
      table.text('data')
      table.timestamp('read_at').nullable()
      table.timestamps()

      // An inbox reads "this recipient's unread notifications, newest first".
      table.index(['notifiable_type', 'notifiable_id'])
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('notifications')
  }
}
