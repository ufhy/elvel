import { Migration, type MigrationContext } from '@elysian/database'

/**
 * Where the `database` session driver keeps sessions.
 *
 * `last_activity` is a unix timestamp rather than a datetime: expiry is then
 * arithmetic on an integer, which every dialect agrees about, and the sweep is
 * one indexed comparison.
 *
 * `user_id` is nullable and indexed so "sign this person out everywhere" is a
 * query rather than a scan — nothing writes it yet, but the column is free now
 * and a migration later.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('sessions', (table) => {
      table.string('id').primary()
      table.foreignId('user_id').nullable().index()
      table.string('ip_address', 45).nullable()
      table.text('user_agent').nullable()
      table.text('payload')
      table.integer('last_activity').index()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('sessions')
  }
}
