import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Create Telescope Entries Table
 *
 * One row per thing that happened, correlated by `batch_id` — the shape Laravel
 * Telescope uses, because the useful question is never "show me every query" but
 * "show me what *this request* did".
 *
 * `batch_id` is nullable on purpose: a queue worker and a console command have
 * things worth recording and no request to hang them off.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('telescope_entries', (table) => {
      table.id()

      /** The request, job or command this belongs to. Null outside all three. */
      table.string('batch_id').nullable().index()

      /** `query`, `request`, `cache`, `model`, `job`, `event`, and so on. */
      table.string('type').index()

      table.json('content')

      table.timestamp('recorded_at')
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('telescope_entries')
  }
}
