import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '@elvel/console'
import { Str } from '@elvel/support'
import { MakeMigrationCommand } from './make-migration.ts'

/**
 * The base for commands that write **one known migration** —
 * `Illuminate\Console\MigrationGeneratorCommand`.
 *
 * `make:migration` writes whatever you name; these write a specific table the
 * framework itself needs (`jobs`, `cache`, `notifications`), so they know their
 * own stub and their own default table name and only differ in those two things.
 *
 * The important behaviour is the refusal. A generated migration carries a
 * timestamp, so a second run would happily write
 * `2026_08_12_121543_create_jobs_table.ts` beside an existing
 * `2026_08_12_064514_create_jobs_table.ts` and the migrator would then try to
 * create the same table twice. Laravel globs for *any* migration whose name ends
 * in `create_<table>_table`; so does this, which is why the check cannot live in
 * a subclass.
 */
export abstract class MigrationGeneratorCommand extends Command {
  /** The stub's file name, resolved from the owning package. */
  protected abstract stubName(): string

  /** Where that package keeps its stubs — pass `import.meta.dir` from there. */
  protected abstract stubDirectory(): string

  /** Used when `--table` is absent. */
  protected abstract defaultTable(): string

  async handle(): Promise<number> {
    const table = Str.snake(this.stringOption('table') || this.defaultTable())

    const existing = await this.existingMigration(table)

    if (existing !== undefined && !this.flag('force')) {
      this.error(`A migration for [${table}] already exists: ${existing}`)
      this.info('Pass --force to write another one anyway.')

      return 1
    }

    const destination = join(
      this.directory(),
      `${MakeMigrationCommand.timestamp()}_create_${table}_table.ts`
    )

    const contents = Str.replacePlaceholders(await this.stub(), { table })

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, contents)

    this.output.tag('INFO', `Migration created: ${relative(this.app.basePath(), destination)}`)
    this.info('Then run: elvel migrate')

    return 0
  }

  /** The first migration that already creates this table, relative to the app. */
  private async existingMigration(table: string): Promise<string | undefined> {
    const directory = this.directory()

    for await (const found of new Bun.Glob(`*create_${table}_table.ts`).scan({
      cwd: directory,
      onlyFiles: true
    })) {
      return relative(this.app.basePath(), join(directory, found))
    }

    return undefined
  }

  private directory(): string {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured[0] ?? this.app.basePath('database', 'migrations')
  }

  /** A stub published into the application's own `stubs/` wins. */
  private async stub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stubName()))
    if (await published.exists()) return published.text()

    return Bun.file(join(this.stubDirectory(), '..', '..', 'stubs', this.stubName())).text()
  }
}
