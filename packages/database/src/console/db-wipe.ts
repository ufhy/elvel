import { MigrationCommand } from './base.ts'

/**
 * Drop everything and stop — Laravel's `db:wipe`.
 *
 * `migrate:fresh` is this plus a migrate; the difference matters when the schema
 * is about to arrive from somewhere else, a dump being loaded or a test suite
 * building its own. Re-running the migrations first would only be undone.
 */
export class DbWipeCommand extends MigrationCommand {
  static override signature =
    'db:wipe {--database= : The connection to wipe} {--force : Run without confirming in production}'

  static override description = 'Drop every table in the database'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const dropped = await (await this.migrator()).wipe()

    this.success(`${dropped.length} table(s) dropped.`)

    return 0
  }
}
