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

  /**
   * Is there an index by this name, or covering these columns?
   *
   * A name is compared directly; an array is compared against the name a
   * migration would have generated for it (`users_email_index`), because that is
   * what a caller who wrote `table.index(['email'])` knows.
   */
  async hasIndex(table: string, index: string | string[]): Promise<boolean> {
    const names = await this.getIndexListing(table)
    const wanted = Array.isArray(index)
      ? `${table}_${index.join('_')}_index`.toLowerCase()
      : index.toLowerCase()

    return names.includes(wanted)
  }

  async getIndexListing(table: string): Promise<string[]> {
    const { sql } = this.grammar.compileIndexListing(table)
    const rows = await this.connection.select<Record<string, unknown>>(sql, [table])

    return rows.map((row) => String(row[this.grammar.indexListingKey] ?? '').toLowerCase())
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
    /**
     * SQLite cannot alter a column, so changing one means rebuilding the table.
     *
     * It needs the *current* schema to do that, which a grammar cannot see —
     * hence the detour here rather than another `compile` branch.
     */
    if (this.grammar.rebuildsToChange && blueprint.columns.some((c) => c.attributes.change)) {
      await this.rebuildForChange(blueprint)

      return
    }

    for (const sql of this.grammar.compile(blueprint)) {
      await this.connection.statement(sql)
    }
  }

  /**
   * SQLite's twelve-step table rebuild, as the documentation prescribes it.
   *
   * Create a new table with the wanted definition, copy the rows across, drop
   * the old one, rename the new one into its place, then put the indexes back.
   * The order matters and so does the foreign-key toggle: with constraints on,
   * dropping the old table would either fail or — worse, on older builds —
   * cascade into the tables pointing at it.
   *
   * The copy names its columns explicitly. `insert into t select * from old`
   * would depend on column *order* matching, which a rebuild is free to change.
   */
  private async rebuildForChange(blueprint: Blueprint): Promise<void> {
    const table = blueprint.table
    const existing = await this.getColumnDefinitions(table)

    if (existing.length === 0) {
      throw new Error(`Cannot change a column on [${table}]: the table does not exist.`)
    }

    const changed = new Map(
      blueprint.columns
        .filter((column) => column.attributes.change)
        .map((column) => [column.attributes.name.toLowerCase(), column.attributes])
    )

    for (const name of changed.keys()) {
      if (!existing.some((column) => column.name.toLowerCase() === name)) {
        throw new Error(`Cannot change [${name}] on [${table}]: there is no such column.`)
      }
    }

    const temporary = `__elysian_rebuild_${table}`
    const definitions = existing.map((column) => {
      const replacement = changed.get(column.name.toLowerCase())

      return replacement
        ? this.grammar.columnDefinition({ ...replacement, name: column.name })
        : column.definition
    })

    const names = existing.map((column) => this.grammar.wrapColumn(column.name)).join(', ')
    const indexes = await this.getIndexDefinitions(table)

    await this.connection.unprepared(this.grammar.compileDisableForeignKeys())

    try {
      await this.connection.statement(
        `create table ${this.grammar.wrapColumn(temporary)} (${definitions.join(', ')})`
      )
      await this.connection.statement(
        `insert into ${this.grammar.wrapColumn(temporary)} (${names}) select ${names} from ${this.grammar.wrapColumn(table)}`
      )
      await this.connection.statement(`drop table ${this.grammar.wrapColumn(table)}`)
      await this.connection.statement(
        `alter table ${this.grammar.wrapColumn(temporary)} rename to ${this.grammar.wrapColumn(table)}`
      )

      // Indexes belong to the table that was dropped, so they are recreated from
      // the definitions read before the rebuild.
      for (const index of indexes) await this.connection.statement(index)
    } finally {
      await this.connection.unprepared(this.grammar.compileEnableForeignKeys())
    }
  }

  /** Each column as SQLite itself declares it, for a rebuild. */
  private async getColumnDefinitions(
    table: string
  ): Promise<Array<{ name: string; definition: string }>> {
    const rows = await this.connection.select<Record<string, unknown>>(
      `pragma table_info(${this.grammar.wrapColumn(table)})`
    )

    return rows.map((row) => {
      const name = String(row.name)
      const parts = [this.grammar.wrapColumn(name), String(row.type || 'text')]

      // `pk` is the column's position in the primary key, so 1 on a single-column
      // key. A compound key cannot be restated inline and is left to the index
      // pass, which is also how SQLite itself reports it.
      if (Number(row.pk) === 1) parts.push('primary key')
      if (Number(row.notnull) === 1) parts.push('not null')
      if (row.dflt_value !== null && row.dflt_value !== undefined) {
        parts.push(`default ${String(row.dflt_value)}`)
      }

      return { name, definition: parts.join(' ') }
    })
  }

  /** The `create index` statements SQLite stored for this table. */
  private async getIndexDefinitions(table: string): Promise<string[]> {
    const rows = await this.connection.select<Record<string, unknown>>(
      "select sql from sqlite_master where type = 'index' and tbl_name = ? and sql is not null",
      [table]
    )

    return rows.map((row) => String(row.sql))
  }
}
