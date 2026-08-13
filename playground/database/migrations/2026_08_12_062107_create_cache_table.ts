import { Migration, type MigrationContext } from '@elysian/database'

/**
 * Tables for the `database` cache store.
 *
 * `cache` holds the entries; `cache_locks` holds atomic locks, and is separate so
 * flushing the cache cannot drop a lock somebody is holding. Both use the key as
 * the primary key: that is what makes `insertOrIgnore` an atomic "write if
 * absent", which is the whole basis of `add()` and of the locks.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('cache', (table) => {
      table.string('key').primary()
      table.text('value')
      table.bigInteger('expiration')
      table.index(['expiration'])
    })

    await schema.create('cache_locks', (table) => {
      table.string('key').primary()
      table.string('owner')
      table.bigInteger('expiration')
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('cache_locks')
    await schema.dropIfExists('cache')
  }
}
