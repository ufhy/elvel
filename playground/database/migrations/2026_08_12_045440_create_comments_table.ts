import { Migration, type MigrationContext } from '@elyvel/database'

/**
 * Create Comments Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('comments', (table) => {
      table.id()
      table.foreignId('article_id').constrained('articles').cascadeOnDelete()
      table.string('author')
      table.text('body')
      table.timestamps()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('comments')
  }
}
