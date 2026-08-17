import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Create Articles Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('articles', (table) => {
      table.id()
      table.string('title')
      table.string('slug').unique()
      table.text('body')
      table.string('status').default('draft')
      table.boolean('featured').default(false)
      table.text('meta').nullable()
      table.timestamp('published_at').nullable()
      table.timestamps()
      table.softDeletes()
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('articles')
  }
}
