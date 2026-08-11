import { Migration, type MigrationContext } from '@elysian/database'

/**
 * Create Articles Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('articles', (table) => {
      table.id()
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('articles')
  }
}
