import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '@elysian/console'
import { MakeMigrationCommand } from '@elysian/database'
import { Str } from '@elysian/support'

/** `queue:table` and `queue:failed-table` share everything but the stub. */
abstract class QueueMigrationCommand extends Command {
  protected abstract stubName(): string

  protected abstract defaultTable(): string

  async handle(): Promise<number> {
    const table = Str.snake(this.stringOption('table') || this.defaultTable())

    const destination = join(
      this.directory(),
      `${MakeMigrationCommand.timestamp()}_create_${table}_table.ts`
    )

    if ((await Bun.file(destination).exists()) && !this.flag('force')) {
      this.error(`Migration already exists: ${relative(this.app.basePath(), destination)}`)
      return 1
    }

    const contents = Str.replacePlaceholders(await this.stub(), { table })

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, contents)

    this.output.tag('INFO', `Migration created: ${relative(this.app.basePath(), destination)}`)
    this.info('Then run: artisan migrate')

    return 0
  }

  private directory(): string {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured[0] ?? this.app.basePath('database', 'migrations')
  }

  private async stub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stubName()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stubName())).text()
  }
}

export class QueueTableCommand extends QueueMigrationCommand {
  static override signature =
    'queue:table {--table=jobs : Name of the jobs table} {--force : Overwrite an existing file}'

  static override description = 'Create a migration for the database queue driver'

  protected stubName(): string {
    return 'queue-table.stub'
  }

  protected defaultTable(): string {
    return 'jobs'
  }
}

export class QueueFailedTableCommand extends QueueMigrationCommand {
  static override signature =
    'queue:failed-table {--table=failed_jobs : Name of the failed jobs table} {--force : Overwrite an existing file}'

  static override description = 'Create a migration for the failed queue jobs table'

  protected stubName(): string {
    return 'failed-jobs-table.stub'
  }

  protected defaultTable(): string {
    return 'failed_jobs'
  }
}
