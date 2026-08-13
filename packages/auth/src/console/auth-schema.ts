import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '@elysian/console'
import { MakeMigrationCommand, SchemaBuilder } from '@elysian/database'
import { type Dialect, diffMigrationFor, schemaShape } from '../adapter.ts'

/** What better-auth's factory-wrapped adapter exposes for schema generation. */
type SchemaCapableAdapter = {
  createSchema?: (
    options: unknown,
    file?: string
  ) => Promise<{ code: string; path: string; overwrite?: boolean }>
}

/**
 * `auth:schema`
 *
 * Writes a migration for better-auth's tables. The schema is whatever the
 * configured better-auth instance asks for — enable a plugin, run this again,
 * and the new tables and columns come with it.
 *
 * Generating rather than shipping a fixed migration is the point: the schema is
 * defined by the options and plugins in `config/auth.ts`, so no hand-written
 * file can stay correct.
 */
export class AuthSchemaCommand extends Command {
  static override signature =
    'auth:schema {--name=create_auth_tables : Migration name} {--force : Overwrite an existing file} {--diff : Write only what the database is missing} {--connection= : Connection to compare against}'

  static override description = "Generate a migration for better-auth's tables"

  async handle(): Promise<number> {
    if (!this.app.bound('auth')) {
      this.error('Auth is not registered. Add AuthServiceProvider to config/app.ts.')
      return 1
    }

    const context = (await (
      this.app.make('auth').instance as unknown as {
        $context: Promise<{ adapter: SchemaCapableAdapter; options: unknown }>
      }
    ).$context) as { adapter: SchemaCapableAdapter; options: unknown }

    if (typeof context.adapter.createSchema !== 'function') {
      this.error('The configured auth adapter cannot generate a schema.')
      return 1
    }

    const name = this.stringOption('name') || 'create_auth_tables'
    const destination = join(this.directory(), `${MakeMigrationCommand.timestamp()}_${name}.ts`)

    const file = Bun.file(destination)
    if ((await file.exists()) && !this.flag('force')) {
      this.error(`Migration already exists: ${relative(this.app.basePath(), destination)}`)
      return 1
    }

    if (this.flag('diff')) return this.writeDiff(context, destination)

    const schema = await context.adapter.createSchema(context.options, destination)

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, schema.code)

    this.output.tag('INFO', `Migration created: ${relative(this.app.basePath(), destination)}`)
    this.info('Review it, then run: artisan migrate')

    return 0
  }

  /**
   * Write a migration for the difference, not the whole schema.
   *
   * Adding a better-auth plugin mid-project asks for two new columns on a table
   * that already holds users; the full migration would try to create that table
   * again. Without this the answer is "hand-edit it", and a hand-edited auth
   * migration is one nobody dares run twice.
   */
  private async writeDiff(
    context: { adapter: SchemaCapableAdapter; options: unknown },
    destination: string
  ): Promise<number> {
    if (!this.app.bound('db')) {
      this.error('--diff needs DatabaseServiceProvider: it compares against the real database.')

      return 1
    }

    const generated = await (
      context.adapter.createSchema as (
        options: unknown,
        file?: string
      ) => Promise<{ code: string; tables?: unknown }>
    )(context.options, destination)

    const tables = generated.tables as never

    if (!tables) {
      this.error(
        'The configured auth adapter did not report its tables, so there is nothing to diff.'
      )

      return 1
    }

    const manager = this.app.make('db')
    const connection = await manager.connection(this.stringOption('connection') || undefined)
    const builder = new SchemaBuilder(connection)

    const existing = new Map<string, string[]>()

    for (const { table } of schemaShape(tables)) {
      if (!(await builder.hasTable(table))) continue

      existing.set(table.toLowerCase(), await builder.getColumnListing(table))
    }

    const diff = diffMigrationFor(tables, connection.grammar.dialect as Dialect, existing)

    if (!diff) {
      this.output.tag('INFO', 'The auth tables already match the configuration.')

      return 0
    }

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, diff.code)

    for (const { table, columns } of diff.missing) this.comment(`${table}: ${columns.join(', ')}`)

    this.output.tag('INFO', `Migration created: ${relative(this.app.basePath(), destination)}`)
    this.info('Review it, then run: artisan migrate')

    return 0
  }

  private directory(): string {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured[0] ?? this.app.basePath('database', 'migrations')
  }
}
