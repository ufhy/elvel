import { Migration, type MigrationContext } from '@elysian/database'

/**
 * Add Secret To Articles Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door —
 * reverse every change `up()` makes, in the opposite order.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.table('articles', (table) => {
      /**
       * Holds a ciphertext, so it is `text` rather than a sized string: the
       * payload is longer than the value it hides, and by a margin that depends
       * on the value.
       */
      table.text('editor_note').nullable()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.table('articles', (table) => {
      table.dropColumn('editor_note')
    })
  }
}
