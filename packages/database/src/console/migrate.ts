import { isAbsolute, join } from 'node:path'
import type { ConnectionManager } from '../connection/manager.ts'
import { MigrationCommand } from './base.ts'

export class MigrateCommand extends MigrationCommand {
  static override signature =
    'migrate {--database= : The connection to use} {--step : Record each migration in its own batch} {--pretend : Show the migrations that would run} {--force : Run without confirming in production} {--isolated : Skip if another migrate is already running} {--schema-path= : The schema dump to load first} {--skip-schema : Ignore any schema dump}'

  static override description = 'Run the pending database migrations'

  /** Deploy runs this on every node at once; only one of them should migrate. */
  static override isolatable = true

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const migrator = await this.migrator()

    /**
     * A stored schema stands in for the migrations that produced it.
     *
     * Loaded only when nothing has run yet — that is the fresh-database case a
     * squashed schema exists for. On a database mid-history it would replay
     * table creations that already exist.
     */
    if (
      !this.flag('pretend') &&
      !this.flag('skip-schema') &&
      !(await migrator.hasRunAnyMigrations())
    ) {
      await this.loadSchema()
    }

    const applied = await migrator.run({
      step: this.flag('step'),
      pretend: this.flag('pretend')
    })

    if (applied.length > 0) this.success(`${applied.length} migration(s) applied.`)

    return 0
  }

  private async loadSchema(): Promise<void> {
    const manager = this.app.make('db') as ConnectionManager
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const configured = this.stringOption('schema-path')
    const path =
      configured === ''
        ? this.app.basePath('database', 'schema', `${connection.name}-schema.sql`)
        : isAbsolute(configured)
          ? configured
          : join(this.app.basePath(), configured)

    const file = Bun.file(path)
    if (!(await file.exists())) return

    this.output.tag('INFO', `Loading stored schema: ${path.replace(`${this.app.basePath()}/`, '')}`)

    /**
     * Statement by statement rather than one `unprepared` call.
     *
     * Bun's drivers send a multi-statement string in one round trip on some
     * engines and refuse it on others, and a dump that half-applied would leave
     * a database nobody can migrate forward or roll back.
     */
    for (const statement of splitStatements(await file.text())) {
      await connection.unprepared(statement)
    }
  }
}

/**
 * Split a dump into statements on semicolons that end a line.
 *
 * Deliberately simple, and it is why the dump is generated rather than
 * hand-written: a semicolon inside a string literal or a `$$`-quoted function
 * body would defeat this. `pg_dump` and `mysqldump` both put a newline after
 * every statement terminator, which is what makes the rule hold for what we
 * actually load.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement !== '' && !statement.split('\n').every((line) => line.trim().startsWith('--'))
    )
}
