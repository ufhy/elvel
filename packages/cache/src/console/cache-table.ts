import { MigrationGeneratorCommand } from '@elyvel/database'

/** `cache:table` — write the migration the `database` store needs. */
export class CacheTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'cache:table {--table=cache : Name of the cache table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the database cache store'

  protected stubName(): string {
    return 'cache-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'cache'
  }
}
