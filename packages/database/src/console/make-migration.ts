import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '@elyvel/console'
import { Str } from '@elyvel/support'

/**
 * `make:migration create_users_table`
 *
 * The file name is prefixed with a UTC timestamp because the migrator orders by
 * name, so lexical order has to equal chronological order.
 */
export class MakeMigrationCommand extends Command {
  static override signature =
    'make:migration {name : Migration name, e.g. create_users_table} {--table= : The table the migration targets} {--force : Overwrite an existing file}'

  static override description = 'Create a new migration file'

  async handle(): Promise<number> {
    const name = Str.snake(this.argument('name'))
    if (name === '') {
      this.error('A name is required.')
      return 1
    }

    const destination = join(this.directory(), `${MakeMigrationCommand.timestamp()}_${name}.ts`)
    const file = Bun.file(destination)

    if ((await file.exists()) && !this.flag('force')) {
      this.error(`Migration already exists: ${relative(this.app.basePath(), destination)}`)
      return 1
    }

    const contents = Str.replacePlaceholders(await this.stub(name), {
      studly: Str.headline(name),
      table: this.targetTable(name),
      name
    })

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, contents)

    this.output.tag('INFO', `Migration created: ${relative(this.app.basePath(), destination)}`)

    return 0
  }

  /** `2026_08_11_143002` — sortable, and unique enough per second. */
  static timestamp(now = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0')

    return [
      now.getUTCFullYear(),
      pad(now.getUTCMonth() + 1),
      pad(now.getUTCDate()),
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    ].join('_')
  }

  private directory(): string {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured[0] ?? this.app.basePath('database', 'migrations')
  }

  /** Infer the table from `create_users_table`, unless --table says otherwise. */
  private targetTable(name: string): string {
    const explicit = this.stringOption('table')
    if (explicit !== '') return explicit

    const match = /^create_(.+)_table$/.exec(name) ?? /^(?:add|drop).*_to_(.+)_table$/.exec(name)

    return match?.[1] ?? 'table_name'
  }

  /**
   * `create_users_table` gets the create stub; anything else is an alteration
   * and gets one built around `schema.table()`, as Laravel picks between its
   * `migration.create` and `migration.update` stubs.
   */
  private async stub(name: string): Promise<string> {
    const file = /^create_.+_table$/.test(name) ? 'migration.stub' : 'migration-update.stub'

    const published = Bun.file(this.app.basePath('stubs', file))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', file)).text()
  }
}
