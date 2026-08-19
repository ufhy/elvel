import pc from 'picocolors'
import { MigrationCommand } from './base.ts'

export class DbShowCommand extends MigrationCommand {
  static override signature = 'db:show {--database= : The connection to inspect}'

  static override description = 'Show the tables in the database'

  async handle(): Promise<number> {
    const manager = this.app.make('db')
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const dialect = connection.grammar.dialect
    const sql =
      dialect === 'sqlite'
        ? "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
        : dialect === 'postgres'
          ? 'select tablename as name from pg_catalog.pg_tables where schemaname = current_schema() order by tablename'
          : 'select table_name as name from information_schema.tables where table_schema = database() order by table_name'

    const tables = await connection.select<{ name: string }>(sql)

    this.line()
    this.output.pairs([
      ['Connection', connection.name],
      ['Driver', dialect],
      ['Tables', String(tables.length)]
    ])
    this.line()

    if (tables.length === 0) {
      this.warn('No tables. Run migrate first.')
      return 0
    }

    // A row count per table is worth the extra queries: it is the first thing
    // anyone opening this command wants to know.
    const rows: string[][] = []
    for (const { name: table } of tables) {
      const [count] = await connection.select<{ total: number }>(
        `select count(*) as total from ${connection.grammar.wrapTable(table)}`
      )
      rows.push([table, String(count?.total ?? 0)])
    }

    this.table(['TABLE', 'ROWS'], rows)
    this.line()
    this.comment(`  ${pc.dim('bun run elvel db:table <name>')} for columns`)
    this.line()

    return 0
  }
}
