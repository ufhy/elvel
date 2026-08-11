import type { Connection } from '../connection/connection.ts'
import { Blueprint } from './blueprint.ts'
import type { SchemaGrammar } from './grammar.ts'
import { MySqlSchemaGrammar } from './grammars/mysql.ts'
import { PostgresSchemaGrammar } from './grammars/postgres.ts'
import { SQLiteSchemaGrammar } from './grammars/sqlite.ts'

export function schemaGrammarFor(dialect: string): SchemaGrammar {
  switch (dialect) {
    case 'sqlite':
      return new SQLiteSchemaGrammar()
    case 'mysql':
    case 'mariadb':
      return new MySqlSchemaGrammar()
    case 'postgres':
      return new PostgresSchemaGrammar()
    default:
      throw new Error(`No schema grammar for dialect [${dialect}].`)
  }
}

/**
 * `Schema.create('users', (table) => …)` — the migration-facing API.
 */
export class SchemaBuilder {
  readonly grammar: SchemaGrammar

  constructor(private readonly connection: Connection) {
    this.grammar = schemaGrammarFor(connection.grammar.dialect)
  }

  async create(table: string, callback: (table: Blueprint) => void): Promise<void> {
    const blueprint = new Blueprint(table).create()
    callback(blueprint)

    await this.build(blueprint)
  }

  /** Alter an existing table. */
  async table(table: string, callback: (table: Blueprint) => void): Promise<void> {
    const blueprint = new Blueprint(table)
    callback(blueprint)

    await this.build(blueprint)
  }

  async drop(table: string): Promise<void> {
    await this.build(new Blueprint(table).drop())
  }

  async dropIfExists(table: string): Promise<void> {
    await this.build(new Blueprint(table).dropIfExists())
  }

  async rename(from: string, to: string): Promise<void> {
    await this.build(new Blueprint(from).rename(to))
  }

  async hasTable(table: string): Promise<boolean> {
    const { sql } = this.grammar.compileTableExists()
    const rows = await this.connection.select(sql, [table])

    return rows.length > 0
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    const columns = await this.getColumnListing(table)

    return columns.includes(column.toLowerCase())
  }

  async getColumnListing(table: string): Promise<string[]> {
    const { sql } = this.grammar.compileColumnListing(table)
    const rows = await this.connection.select<Record<string, unknown>>(sql, [table])

    return rows.map((row) => String(row[this.grammar.columnListingKey] ?? '').toLowerCase())
  }

  async enableForeignKeyConstraints(): Promise<void> {
    await this.connection.unprepared(this.grammar.compileEnableForeignKeys())
  }

  async disableForeignKeyConstraints(): Promise<void> {
    await this.connection.unprepared(this.grammar.compileDisableForeignKeys())
  }

  /** Run `callback` with foreign keys off, restoring them afterwards. */
  async withoutForeignKeyConstraints<T>(callback: () => Promise<T>): Promise<T> {
    await this.disableForeignKeyConstraints()

    try {
      return await callback()
    } finally {
      await this.enableForeignKeyConstraints()
    }
  }

  /** Compile a blueprint without running it — used by `migrate --pretend`. */
  toSql(blueprint: Blueprint): string[] {
    return this.grammar.compile(blueprint)
  }

  private async build(blueprint: Blueprint): Promise<void> {
    for (const sql of this.grammar.compile(blueprint)) {
      await this.connection.statement(sql)
    }
  }
}
