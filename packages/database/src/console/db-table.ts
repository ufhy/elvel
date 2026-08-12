import { SchemaBuilder } from '../schema/builder.ts'
import { MigrationCommand } from './base.ts'

export class DbTableCommand extends MigrationCommand {
  static override signature =
    'db:table {table : The table to describe} {--database= : The connection to inspect}'

  static override description = 'Show the columns of a table'

  async handle(): Promise<number> {
    const manager = this.app.make('db')
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)
    const schema = new SchemaBuilder(connection)
    const table = this.argument('table')

    if (!(await schema.hasTable(table))) {
      this.error(`Table [${table}] does not exist.`)
      return 1
    }

    const columns = await schema.getColumnListing(table)

    this.line()
    this.output.pairs([
      ['Table', table],
      ['Connection', connection.name],
      ['Columns', String(columns.length)]
    ])
    this.line()
    this.table(
      ['COLUMN'],
      columns.map((column) => [column])
    )
    this.line()

    return 0
  }
}
