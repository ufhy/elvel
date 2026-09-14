import type { Blueprint, ColumnAttributes } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'
import {
  action,
  baseType,
  type ColumnInfo,
  type ForeignKeyInfo,
  flag,
  groupBy,
  type IndexInfo,
  nullableText,
  type SchemaRow,
  text
} from '../introspection.ts'

/**
 * SQLite schema grammar.
 *
 * Two details a guess would get wrong: every integer
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
        return 'varchar'
      case 'tinyText':
        return 'text'
      case 'ulid':
        return 'char(26)'
      case 'year':
        return 'integer'
      case 'ipAddress':
        return 'varchar'
      case 'macAddress':
        return 'varchar'
      case 'dateTimeTz':
        return 'datetime'
      case 'timeTz':
        return 'time'
      case 'timestampTz':
        return 'datetime'
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
      case 'vector':
        // Named rather than silently mapped to blob: a vector column that stores
        // bytes nobody can search is worse than a migration that refuses.
        throw new Error(
          `[${column.name}] is a vector column, which needs Postgres with pgvector. sqlite has no equivalent.`
        )
      case 'computed':
        return `${column.sqlType ?? 'text'} generated always as (${column.expression ?? ''}) ${column.stored === false ? 'virtual' : 'stored'}`
      case 'raw':
        return column.expression ?? ''
      case 'geometry':
      case 'geography':
      case 'set':
      case 'tsvector':
        // Named rather than silently mapped to text: a column nobody can search
        // the way the migration meant is worse than a migration that refuses.
        throw new Error(
          `[${column.name}] is a ${column.type} column, which sqlite has no equivalent for.`
        )
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

  compileIndexListing(_table: string) {
    return { sql: 'select name from pragma_index_list(?)', bindings: [] as unknown[] }
  }

  compileEnableForeignKeys(): string {
    return 'PRAGMA foreign_keys = ON'
  }

  compileDisableForeignKeys(): string {
    return 'PRAGMA foreign_keys = OFF'
  }

  /**
   * SQLite has no `alter column`, so a change is a whole-table rebuild.
   *
   * Flagged rather than compiled: the rebuild has to know what the table looks
   * like now, and a grammar sees only the blueprint. `SchemaBuilder` does it.
   */
  override readonly rebuildsToChange = true
  /**
   * SQLite's full-text search is a virtual table, not an index.
   *
   * FTS5 creates a *separate* table that mirrors the columns being searched, so
   * there is nothing to add to this one. Saying so beats emitting an index that
   * the server accepts and that no search will ever use.
   */
  protected override compileFullText(): string {
    throw new Error(
      'SQLite has no full-text index. Its full-text search is an FTS5 virtual table, which a migration creates with a raw statement.'
    )
  }

  protected override compileRenameIndex(): string {
    throw new Error('SQLite cannot rename an index. Drop it and create it under the new name.')
  }

  // ------------------------------------------------------------- inspection

  compileTables() {
    return {
      sql: "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      bindings: [] as unknown[]
    }
  }

  compileViews() {
    return {
      sql: "select name, sql as definition from sqlite_master where type = 'view' order by name",
      bindings: [] as unknown[]
    }
  }

  compileColumns(_table: string) {
    return {
      sql: 'select name, type, "notnull", dflt_value, pk from pragma_table_info(?)',
      bindings: [] as unknown[]
    }
  }

  /**
   * Two pragmas, joined.
   *
   * `pragma_index_list` names the indexes and `pragma_index_info` names their
   * columns, so a two-column index is two rows and the builder folds them. The
   * correlated argument — `pragma_index_info(l.name)` — is what makes it one
   * query rather than one per index.
   */
  compileIndexes(_table: string) {
    return {
      sql: `select l.name, l."unique", l.origin, i.name as column_name, i.seqno
            from pragma_index_list(?) l
            join pragma_index_info(l.name) i
            order by l.name, i.seqno`,
      bindings: [] as unknown[]
    }
  }

  compileForeignKeys(_table: string) {
    return {
      sql: `select id, seq, "table" as foreign_table, "from" as column_name,
                   "to" as foreign_column, on_update, on_delete
            from pragma_foreign_key_list(?)
            order by id, seq`,
      bindings: [] as unknown[]
    }
  }

  mapColumns(rows: SchemaRow[]): ColumnInfo[] {
    return rows.map((row) => {
      const type = text(row.type) || 'text'

      return {
        name: text(row.name),
        type,
        typeName: baseType(type),
        nullable: !flag(row.notnull),
        default: nullableText(row.dflt_value),
        /**
         * SQLite's rowid alias, which is what `id()` produces.
         *
         * A single-column integer primary key *is* the rowid and increments on
         * its own, whether or not the table says `autoincrement`. Reporting the
         * keyword instead would call the ordinary case not auto-incrementing.
         */
        autoIncrement: flag(row.pk) && baseType(type) === 'integer',
        comment: null
      }
    })
  }

  mapIndexes(rows: SchemaRow[]): IndexInfo[] {
    return groupBy(
      rows,
      (row) => text(row.name),
      (name, group) => ({
        name,
        columns: group.map((row) => text(row.column_name)),
        unique: flag(group[0]?.unique),
        // `pk` is the origin SQLite gives an index it made for a primary key.
        primary: text(group[0]?.origin) === 'pk'
      })
    )
  }

  mapForeignKeys(rows: SchemaRow[], table: string): ForeignKeyInfo[] {
    return groupBy(
      rows,
      // SQLite gives a foreign key an id rather than a name, so the id is the
      // grouping and the name is built the way a migration would have named it.
      (row) => text(row.id),
      (_id, group) => ({
        name: `${table}_${group.map((row) => text(row.column_name)).join('_')}_foreign`,
        columns: group.map((row) => text(row.column_name)),
        foreignTable: text(group[0]?.foreign_table),
        foreignColumns: group.map((row) => text(row.foreign_column)),
        onUpdate: action(group[0]?.on_update),
        onDelete: action(group[0]?.on_delete)
      })
    )
  }
}
