import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Create Taggables Table
 *
 * `down()` is not optional: a migration you cannot reverse is a one-way door.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    /**
     * One pivot table for every kind of taggable thing.
     *
     * `taggable_type` is what keeps an article's tags apart from a comment's, so
     * it belongs in the key: without it, two rows for id 1 of different types
     * collide.
     */
    await schema.create('taggables', (table) => {
      table.foreignId('tag_id')
      table.foreignId('taggable_id')
      table.string('taggable_type')
      table.string('added_by').nullable()
      table.timestamp('created_at').nullable()
      table.timestamp('updated_at').nullable()
      table.primary(['tag_id', 'taggable_id', 'taggable_type'])
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('taggables')
  }
}
