import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '@elysian/console'
import { MakeMigrationCommand } from '@elysian/database'
import { Str } from '@elysian/support'

/** `notifications:table` — the migration the database channel needs. */
export class NotificationsTableCommand extends Command {
  static override signature =
    'notifications:table {--table=notifications : Name of the table} {--force : Overwrite an existing file}'

  static override description = 'Create a migration for the notifications table'

  async handle(): Promise<number> {
    const table = Str.snake(this.stringOption('table') || 'notifications')

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
    const published = Bun.file(this.app.basePath('stubs', 'notifications-table.stub'))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', 'notifications-table.stub')).text()
  }
}
