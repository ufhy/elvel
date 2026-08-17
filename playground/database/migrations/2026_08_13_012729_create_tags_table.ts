import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Create Tags Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('tags', (table) => {
      table.id()
      table.string('label').unique()
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('tags')
  }
}
