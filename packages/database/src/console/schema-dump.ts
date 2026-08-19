import { mkdir, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProcessManager } from '@elvel/process'
import type { ConnectionManager } from '../connection/manager.ts'
import { MigrationCommand } from './base.ts'

/**
 * `schema:dump` — write the current schema to a file so migrations can be squashed.
 *
 * The problem it solves is real and slow: an application three years old runs
 * four hundred migrations to create a test database, most of them altering a
 * column that a later one drops. A dump is the same schema in one file, and
 * `migrate` loads it when no migration has run yet.
 *
 * SQLite is dumped from `sqlite_master`, which is the schema exactly as the
 * engine stored it. Postgres and MySQL shell out to `pg_dump` and `mysqldump` —
 * Laravel does the same, and for the same reason: reproducing what those tools
 * emit, down to sequence ownership and index storage parameters, is a project of
 * its own and getting it subtly wrong yields a schema that restores but differs.
 */
export class SchemaDumpCommand extends MigrationCommand {
  static override signature =
    'schema:dump {--database= : The connection to dump} {--path= : Where to write the dump} {--prune : Delete the migration files the dump replaces}'

  static override description = 'Dump the current database schema to a file'

  async handle(): Promise<number> {
    const manager = this.app.make('db') as ConnectionManager
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const path = this.destination(connection.name)
    const dialect = connection.grammar.dialect

    let sql: string

    try {
      sql = dialect === 'sqlite' ? await this.dumpSqlite() : await this.dumpWithTool(dialect, name)
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))

      return 1
    }

    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, sql)

    this.output.tag('INFO', `Schema dumped to ${path.replace(`${this.app.basePath()}/`, '')}.`)

    if (this.flag('prune')) {
      const pruned = await this.prune()

      this.output.tag('INFO', `Deleted ${pruned} migration file(s).`)
    }

    return 0
  }

  private destination(connection: string): string {
    const configured = this.stringOption('path')

    if (configured !== '') return configured

    return this.app.basePath('database', 'schema', `${connection}-schema.sql`)
  }

  /**
   * SQLite's own record of the schema, plus the migrations already applied.
   *
   * The rows matter as much as the tables: a dump that restores the schema but
   * forgets which migrations produced it would have `migrate` run all of them
   * again on top.
   */
  private async dumpSqlite(): Promise<string> {
    const manager = this.app.make('db') as ConnectionManager
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const objects = await connection.select<{ sql: string }>(
      "select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 else 1 end, name"
    )

    const table = this.app.config.get<string>('database.migrations', 'migrations')
    const applied = await connection.select<{ migration: string; batch: number }>(
      `select migration, batch from ${connection.grammar.wrapTable(table)} order by id`
    )

    const lines = [
      '-- Elvel schema dump.',
      '-- Load it with `elvel migrate`, which uses it when no migration has run yet.',
      '',
      ...objects.map((object) => `${object.sql};`),
      ''
    ]

    for (const row of applied) {
      lines.push(
        `insert into ${connection.grammar.wrapTable(table)} (migration, batch) values ('${row.migration.replaceAll("'", "''")}', ${row.batch});`
      )
    }

    return `${lines.join('\n')}\n`
  }

  /**
   * `pg_dump --schema-only` or `mysqldump --no-data`, plus the migration rows.
   *
   * The tool has to be on PATH. Saying so plainly beats a half-written dump: a
   * schema file that is missing its extensions or its sequences restores into a
   * database that looks right until something reaches for the part that is gone.
   */
  private async dumpWithTool(dialect: string, name: string): Promise<string> {
    const config = this.app.config.get<Record<string, unknown>>(
      `database.connections.${name === '' ? this.app.config.get<string>('database.default', '') : name}`,
      {}
    )

    const host = String(config.host ?? '127.0.0.1')
    const port = String(config.port ?? (dialect === 'postgres' ? 5432 : 3306))
    const username = String(config.username ?? '')
    const database = String(config.database ?? '')
    const password = String(config.password ?? '')

    const command =
      dialect === 'postgres'
        ? [
            'pg_dump',
            '--schema-only',
            '--no-owner',
            '--no-privileges',
            '-h',
            host,
            '-p',
            port,
            '-U',
            username,
            database
          ]
        : [
            'mysqldump',
            '--no-data',
            '--skip-comments',
            '-h',
            host,
            '-P',
            port,
            '-u',
            username,
            database
          ]

    /**
     * The password goes in the environment, never in the argv.
     *
     * `ps` shows another user's command line; it does not show their
     * environment. `--password=` on the command line would put the database
     * password on a shared machine's process list for as long as the dump runs.
     */
    const result = await new ProcessManager()
      .env(dialect === 'postgres' ? { PGPASSWORD: password } : { MYSQL_PWD: password })
      .run(command)

    if (result.failed()) {
      throw new Error(
        `${command[0]} failed (${result.exitCode}): ` +
          (result.errorOutput.trim() || 'is it installed and on PATH?')
      )
    }

    return result.output
  }

  /** Delete the migration files the dump now stands for. */
  private async prune(): Promise<number> {
    let deleted = 0

    for (const directory of this.paths()) {
      let entries: string[]

      try {
        entries = await readdir(directory)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.endsWith('.ts')) continue

        await unlink(join(directory, entry))
        deleted += 1
      }
    }

    return deleted
  }
}
