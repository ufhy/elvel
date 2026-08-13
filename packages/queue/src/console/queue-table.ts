import { MigrationGeneratorCommand } from '@elysian/database'

/** `queue:table` and `queue:failed-table` differ only in their stub and table. */
export class QueueTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'queue:table {--table=jobs : Name of the jobs table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the database queue driver'

  protected stubName(): string {
    return 'queue-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'jobs'
  }
}

export class QueueFailedTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'queue:failed-table {--table=failed_jobs : Name of the failed jobs table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the failed queue jobs table'

  protected stubName(): string {
    return 'failed-jobs-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'failed_jobs'
  }
}

export class QueueBatchesTableCommand extends MigrationGeneratorCommand {
  static override signature =
    'queue:batches-table {--table=job_batches : Name of the batches table} {--force : Write one even if a migration for the table exists}'

  static override description = 'Create a migration for the job batches table'

  protected stubName(): string {
    return 'batches-table.stub'
  }

  protected stubDirectory(): string {
    return import.meta.dir
  }

  protected defaultTable(): string {
    return 'job_batches'
  }
}
