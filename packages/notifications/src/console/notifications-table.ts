import { MigrationGeneratorCommand } from '@elysian/database'

/** `notifications:table` — the migration the database channel needs. */
export class NotificationsTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'notifications:table {--table=notifications : Name of the table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the notifications table'

  protected stubName(): string {
    return 'notifications-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'notifications'
  }
}
