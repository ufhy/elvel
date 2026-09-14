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

    const columns = await schema.getColumns(table)
    const indexes = await schema.getIndexes(table)
    const keys = await schema.getForeignKeys(table)

    this.line()
    this.output.pairs([
      ['Table', table],
      ['Connection', connection.name],
      ['Columns', String(columns.length)]
    ])
    this.line()
    this.table(
      ['COLUMN', 'TYPE', 'NULLABLE', 'DEFAULT'],
      columns.map((column) => [
        column.autoIncrement ? `${column.name} (auto)` : column.name,
        column.type,
        column.nullable ? 'yes' : 'no',
        column.default ?? ''
      ])
    )

    if (indexes.length > 0) {
      this.line()
      this.table(
        ['INDEX', 'COLUMNS', 'KIND'],
        indexes.map((index) => [
          index.name,
          index.columns.join(', '),
          index.primary ? 'primary' : index.unique ? 'unique' : 'index'
        ])
      )
    }

    if (keys.length > 0) {
      this.line()
      this.table(
        ['FOREIGN KEY', 'COLUMNS', 'REFERENCES', 'ON DELETE'],
        keys.map((key) => [
          key.name,
          key.columns.join(', '),
          `${key.foreignTable} (${key.foreignColumns.join(', ')})`,
          key.onDelete ?? ''
        ])
      )
    }

    this.line()

    return 0
  }
}
