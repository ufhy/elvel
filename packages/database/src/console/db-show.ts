import pc from 'picocolors'
import { SchemaBuilder } from '../schema/builder.ts'
import { MigrationCommand } from './base.ts'

export class DbShowCommand extends MigrationCommand {
  static override signature = 'db:show {--database= : The connection to inspect}'

  static override description = 'Show the tables in the database'

  async handle(): Promise<number> {
    const manager = this.app.make('db')
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const dialect = connection.grammar.dialect
    const schema = new SchemaBuilder(connection)
    const tables = await schema.getTables()
    const views = await schema.getViews()

    this.line()
    this.output.pairs([
      ['Connection', connection.name],
      ['Driver', dialect],
      ['Tables', String(tables.length)],
      ['Views', String(views.length)]
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
