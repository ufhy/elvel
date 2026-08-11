import type { Blueprint, ColumnAttributes } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'

/**
 * SQLite schema grammar.
 *
 * Two details from Laravel's source that a guess would get wrong: every integer
 * width maps to `integer` (SQLite has one integer type), and `Increment` is the
 * *first* modifier, because `primary key autoincrement` must precede `not null`.
 */
export class SQLiteSchemaGrammar extends SchemaGrammar {
  protected modifiers: Modifier[] = ['increment', 'nullable', 'default', 'collate']

  typeFor(column: ColumnAttributes): string {
    switch (column.type) {
      case 'bigInteger':
      case 'integer':
      case 'mediumInteger':
      case 'smallInteger':
      case 'tinyInteger':
        return 'integer'
      case 'boolean':
        return 'tinyint(1)'
      case 'string':
      case 'char':
      case 'uuid':
      case 'enum':
        return 'varchar'
      case 'text':
      case 'mediumText':
      case 'longText':
      case 'json':
      case 'jsonb':
        return 'text'
      case 'decimal':
      case 'float':
      case 'double':
        return 'numeric'
      case 'date':
        return 'date'
      case 'dateTime':
      case 'timestamp':
        return 'datetime'
      case 'time':
        return 'time'
      case 'binary':
        return 'blob'
      default: {
        const exhaustive: never = column.type
        throw new Error(`Unsupported column type [${exhaustive}] for sqlite.`)
      }
    }
  }

  /** SQLite omits an explicit `null`; absence of `not null` is nullable. */
  protected override modifyNullable(column: ColumnAttributes): string {
    return column.nullable ? '' : ' not null'
  }

  protected modifyIncrement(_blueprint: Blueprint, column: ColumnAttributes): string {
    return this.serials.includes(column.type) && column.autoIncrement
      ? ' primary key autoincrement'
      : ''
  }

  /** An auto-increment column already declares the primary key inline. */
  protected override inlineConstraints(blueprint: Blueprint): string[] {
    const hasAutoIncrement = blueprint.columns.some((column) => column.attributes.autoIncrement)

    return super
      .inlineConstraints(blueprint)
      .filter((constraint) => !(hasAutoIncrement && constraint.startsWith('primary key')))
  }

  /** SQLite cannot drop a constraint; the table must be rebuilt. */
  protected override compileDropPrimary(): string {
    throw new Error('SQLite cannot drop a primary key; recreate the table instead.')
  }

  protected override compileDropForeign(): string {
    throw new Error('SQLite cannot drop a foreign key; recreate the table instead.')
  }

  compileTableExists() {
    return {
      sql: "select name from sqlite_master where type = 'table' and name = ?",
      bindings: [] as unknown[]
    }
  }

  compileColumnListing(_table: string) {
    return { sql: 'select name from pragma_table_info(?)', bindings: [] as unknown[] }
  }

  compileEnableForeignKeys(): string {
    return 'PRAGMA foreign_keys = ON'
  }

  compileDisableForeignKeys(): string {
    return 'PRAGMA foreign_keys = OFF'
  }
}
