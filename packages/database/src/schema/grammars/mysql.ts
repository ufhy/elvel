import type { Blueprint, ColumnAttributes, Command } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'

export class MySqlSchemaGrammar extends SchemaGrammar {
  protected override quote = '`'

  /** Verbatim from Laravel's MySqlGrammar: unsigned first, position last. */
  protected modifiers: Modifier[] = [
    'unsigned',
    'collate',
    'nullable',
    'default',
    'onUpdate',
    'increment',
    'comment',
    'after',
    'first'
  ]

  typeFor(column: ColumnAttributes): string {
    switch (column.type) {
      case 'bigInteger':
        return 'bigint'
      case 'integer':
        return 'int'
      case 'mediumInteger':
        return 'mediumint'
      case 'smallInteger':
        return 'smallint'
      case 'tinyInteger':
        return 'tinyint'
      case 'boolean':
        return 'tinyint(1)'
      case 'string':
        return `varchar(${column.length ?? 255})`
      case 'char':
        return `char(${column.length ?? 255})`
      case 'tinyText':
        return 'tinytext'
      case 'ulid':
        return 'char(26)'
      case 'year':
        return 'year'
      case 'ipAddress':
        return 'varchar(45)'
      case 'macAddress':
        return 'varchar(17)'
      case 'dateTimeTz':
        return 'datetime'
      case 'timeTz':
        return 'time'
      case 'timestampTz':
        return 'timestamp'
      case 'uuid':
        return 'char(36)'
      case 'enum':
        return `enum(${(column.allowed ?? []).map((value) => `'${value}'`).join(', ')})`
      case 'text':
        return 'text'
      case 'mediumText':
        return 'mediumtext'
      case 'longText':
        return 'longtext'
      case 'json':
      case 'jsonb':
        return 'json'
      case 'decimal':
        return `decimal(${column.total ?? 8}, ${column.places ?? 2})`
      case 'float':
        return `double(${column.total ?? 8}, ${column.places ?? 2})`
      case 'double':
        return 'double'
      case 'date':
        return 'date'
      case 'dateTime':
        return 'datetime'
      case 'timestamp':
        return 'timestamp'
      case 'time':
        return 'time'
      case 'binary':
        return 'blob'
      case 'vector':
        // Named rather than silently mapped to blob: a vector column that stores
        // bytes nobody can search is worse than a migration that refuses.
        throw new Error(
          `[${column.name}] is a vector column, which needs Postgres with pgvector. mysql has no equivalent.`
        )
      default: {
        const exhaustive: never = column.type
        throw new Error(`Unsupported column type [${exhaustive}] for mysql.`)
      }
    }
  }

  protected override modifyUnsigned(column: ColumnAttributes): string {
    return column.unsigned ? ' unsigned' : ''
  }

  protected modifyIncrement(blueprint: Blueprint, column: ColumnAttributes): string {
    if (!this.serials.includes(column.type) || !column.autoIncrement) return ''

    const hasExplicitPrimary = blueprint.commands.some((command) => command.name === 'primary')

    return hasExplicitPrimary ? ' auto_increment' : ' auto_increment primary key'
  }

  protected override compileDropIndex(blueprint: Blueprint, index: string): string {
    return `alter table ${this.wrapTable(blueprint.table)} drop index ${this.wrap(index)}`
  }

  protected override compileDropPrimary(blueprint: Blueprint): string {
    return `alter table ${this.wrapTable(blueprint.table)} drop primary key`
  }

  protected override compileDropForeign(blueprint: Blueprint, index: string): string {
    return `alter table ${this.wrapTable(blueprint.table)} drop foreign key ${this.wrap(index)}`
  }

  compileTableExists() {
    return {
      sql: 'select table_name from information_schema.tables where table_schema = database() and table_name = ?',
      bindings: [] as unknown[]
    }
  }

  compileColumnListing(_table: string) {
    return {
      sql: 'select column_name as name from information_schema.columns where table_schema = database() and table_name = ?',
      bindings: [] as unknown[]
    }
  }

  compileIndexListing(_table: string) {
    return {
      sql: 'select distinct index_name as name from information_schema.statistics where table_schema = database() and table_name = ?',
      bindings: [] as unknown[]
    }
  }

  compileEnableForeignKeys(): string {
    return 'SET FOREIGN_KEY_CHECKS = 1'
  }

  compileDisableForeignKeys(): string {
    return 'SET FOREIGN_KEY_CHECKS = 0'
  }

  /**
   * `alter table t modify `col` <type> <modifiers>`.
   *
   * `modify` restates the column whole, which is MySQL's only form — there is no
   * way to change the type and keep the rest. That is why `change()` reads the
   * definition as a replacement everywhere: anything MySQL is not told, it drops.
   */
  protected override compileChange(blueprint: Blueprint, column: ColumnAttributes): string[] {
    return [
      `alter table ${this.wrapTable(blueprint.table)} modify ${this.columnSql(blueprint, column)}`
    ]
  }
  protected override compileFullText(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'fullText' }>
  ): string {
    return `alter table ${this.wrapTable(blueprint.table)} add fulltext ${this.wrap(command.index)} (${this.columnize(command.columns)})`
  }
}
