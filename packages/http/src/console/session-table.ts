import { MigrationGeneratorCommand } from '@elyvel/database'

/** `session:table` — the migration the `database` session driver needs. */
export class SessionTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'session:table {--table=sessions : Name of the sessions table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the database session driver'

  protected stubName(): string {
    return 'sessions-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'sessions'
  }
}
