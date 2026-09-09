import { MigrationGeneratorCommand } from '@elvel/database'

/** `lens:table` — write the migration the `database` driver needs. */
export class LensTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'lens:table {--table=lens_entries : Name of the entries table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the Lens entry tables'

  protected stubName(): string {
    return 'lens-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'lens_entries'
  }
}
