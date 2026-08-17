import { Migration, type MigrationContext } from '@elyvel/database'

/**
 * Add Author Id To Articles Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door —
 * reverse every change `up()` makes, in the opposite order.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.table('articles', (table) => {
      // better-auth's user ids are strings, so the owning column is one too.
      table.string('author_id').nullable()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.table('articles', (table) => {
      table.dropColumn('author_id')
    })
  }
}
