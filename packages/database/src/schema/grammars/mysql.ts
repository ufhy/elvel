import type { Blueprint, ColumnAttributes, Command } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'
import {
  action,
  type ColumnInfo,
  type ForeignKeyInfo,
  flag,
  groupBy,
  type IndexInfo,
  nullableText,
  type SchemaRow,
  text
} from '../introspection.ts'

export class MySqlSchemaGrammar extends SchemaGrammar {
  protected override quote = '`'

  /** Unsigned first, position last — MySQL rejects any other order. */
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

  // ------------------------------------------------------------- inspection

  compileTables() {
    return {
      sql: `select table_name as name, table_schema as \`schema\`
            from information_schema.tables
            where table_schema = database() and table_type = 'BASE TABLE'
            order by table_name`,
      bindings: [] as unknown[]
    }
  }

  compileViews() {
    return {
      sql: `select table_name as name, table_schema as \`schema\`, view_definition as definition
            from information_schema.views
            where table_schema = database()
            order by table_name`,
      bindings: [] as unknown[]
    }
  }

  compileColumns(_table: string) {
    return {
      sql: `select column_name as name, column_type as type, data_type as type_name,
                   is_nullable as nullable, column_default as \`default\`,
                   extra as extra, column_comment as comment
            from information_schema.columns
            where table_schema = database() and table_name = ?
            order by ordinal_position`,
      bindings: [] as unknown[]
    }
  }

  compileIndexes(_table: string) {
    return {
      sql: `select index_name as name, non_unique as non_unique, seq_in_index as seq,
                   column_name as column_name
            from information_schema.statistics
            where table_schema = database() and table_name = ?
            order by index_name, seq_in_index`,
      bindings: [] as unknown[]
    }
  }

  compileForeignKeys(_table: string) {
    return {
      sql: `select k.constraint_name as name, k.column_name as column_name,
                   k.ordinal_position as ord,
                   k.referenced_table_name as foreign_table,
                   k.referenced_column_name as foreign_column,
                   r.update_rule as on_update, r.delete_rule as on_delete
            from information_schema.key_column_usage k
            join information_schema.referential_constraints r
              on r.constraint_schema = k.constraint_schema
             and r.constraint_name = k.constraint_name
            where k.table_schema = database() and k.table_name = ?
              and k.referenced_table_name is not null
            order by k.constraint_name, k.ordinal_position`,
      bindings: [] as unknown[]
    }
  }

  mapColumns(rows: SchemaRow[]): ColumnInfo[] {
    return rows.map((row) => ({
      name: text(row.name),
      type: text(row.type),
      typeName: text(row.type_name).toLowerCase(),
      nullable: text(row.nullable).toLowerCase() === 'yes',
      default: nullableText(row.default),
      autoIncrement: text(row.extra).toLowerCase().includes('auto_increment'),
      comment: nullableText(row.comment)
    }))
  }

  mapIndexes(rows: SchemaRow[]): IndexInfo[] {
    return groupBy(
      rows,
      (row) => text(row.name),
      (name, group) => ({
        name,
        columns: group.map((row) => text(row.column_name)),
        unique: !flag(group[0]?.non_unique),
        // MySQL has no separate notion of a primary key index: it is the index
        // it always calls PRIMARY.
        primary: name === 'PRIMARY'
      })
    )
  }

  mapForeignKeys(rows: SchemaRow[], _table: string): ForeignKeyInfo[] {
    return groupBy(
      rows,
      (row) => text(row.name),
      (name, group) => ({
        name,
        columns: group.map((row) => text(row.column_name)),
        foreignTable: text(group[0]?.foreign_table),
        foreignColumns: group.map((row) => text(row.foreign_column)),
        onUpdate: action(group[0]?.on_update),
        onDelete: action(group[0]?.on_delete)
      })
    )
  }
}
