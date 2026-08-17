import { Migration, type MigrationContext } from '@elyvel/database'

/**
 * Tables for the `database` queue driver.
 *
 * `reserved_at` is what makes the driver safe: a worker sets it when it takes a
 * job, and a job whose `reserved_at` is older than the connection's `retryAfter`
 * is treated as abandoned and picked up again. Without that column a worker that
 * died would take its jobs with it.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('jobs', (table) => {
      table.id()
      table.string('queue').index()
      table.text('payload')
      table.integer('attempts')
      table.integer('reserved_at').nullable()
      table.integer('available_at')
      table.integer('created_at')
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('jobs')
  }
}
