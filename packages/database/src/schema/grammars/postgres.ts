import type { Blueprint, ColumnAttributes, Command } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'
import {
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

export class PostgresSchemaGrammar extends SchemaGrammar {
  /** The order Postgres accepts. */
  protected modifiers: Modifier[] = ['collate', 'nullable', 'default', 'increment']

  typeFor(column: ColumnAttributes): string {
    switch (column.type) {
      // Postgres expresses auto-increment through the type, not a modifier.
      case 'bigInteger':
        return column.autoIncrement ? 'bigserial' : 'bigint'
      case 'integer':
        return column.autoIncrement ? 'serial' : 'integer'
      case 'mediumInteger':
        return column.autoIncrement ? 'serial' : 'integer'
      case 'smallInteger':
        return column.autoIncrement ? 'smallserial' : 'smallint'
      case 'tinyInteger':
        return column.autoIncrement ? 'smallserial' : 'smallint'
      case 'boolean':
        return 'boolean'
      case 'string':
        return column.length ? `varchar(${column.length})` : 'varchar'
      case 'char':
        return `char(${column.length ?? 255})`
      case 'tinyText':
        return 'varchar(255)'
      case 'ulid':
        return 'char(26)'
      case 'year':
        return 'integer'
      case 'ipAddress':
        return 'inet'
      case 'macAddress':
        return 'macaddr'
      case 'dateTimeTz':
        return 'timestamp with time zone'
      case 'timeTz':
        return 'time with time zone'
      case 'timestampTz':
        return 'timestamp with time zone'
      case 'uuid':
        return 'uuid'
      case 'vector':
        return `vector(${column.length ?? 1536})`
      case 'enum':
        return `varchar(255) check (${this.wrap(column.name)} in (${(column.allowed ?? [])
          .map((value) => `'${value}'`)
          .join(', ')}))`
      case 'text':
      case 'mediumText':
      case 'longText':
        return 'text'
      case 'json':
        return 'json'
      case 'jsonb':
        return 'jsonb'
      case 'decimal':
        return `decimal(${column.total ?? 8}, ${column.places ?? 2})`
      case 'float':
        return `double precision`
      case 'double':
        return 'double precision'
      case 'date':
        return 'date'
      case 'dateTime':
      case 'timestamp':
        return 'timestamp(0) without time zone'
      case 'time':
        return 'time(0) without time zone'
      case 'binary':
        return 'bytea'
      default: {
        const exhaustive: never = column.type
        throw new Error(`Unsupported column type [${exhaustive}] for postgres.`)
      }
    }
  }

  /** Postgres has no unsigned integers, so the modifier is ignored. */
  protected override modifyUnsigned(): string {
    return ''
  }

  /**
   * Postgres has a real boolean type, so `default 1` is a type error rather than
   * a convenience. The other dialects store booleans as integers and accept it.
   */
  protected override defaultValue(value: unknown): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false'

    return super.defaultValue(value)
  }

  protected modifyIncrement(blueprint: Blueprint, column: ColumnAttributes): string {
    if (!this.serials.includes(column.type) || !column.autoIncrement) return ''

    const hasExplicitPrimary = blueprint.commands.some((command) => command.name === 'primary')

    return hasExplicitPrimary ? '' : ' primary key'
  }

  protected override inlineConstraints(blueprint: Blueprint): string[] {
    const hasAutoIncrement = blueprint.columns.some((column) => column.attributes.autoIncrement)

    return super
      .inlineConstraints(blueprint)
      .filter((constraint) => !(hasAutoIncrement && constraint.startsWith('primary key')))
  }

  // Postgres numbers its placeholders, so the introspection queries have to as
  // well — the query grammar is not the only place this leaks.
  compileTableExists() {
    return {
      sql: 'select tablename from pg_catalog.pg_tables where schemaname = current_schema() and tablename = $1',
      bindings: [] as unknown[]
    }
  }

  compileColumnListing(_table: string) {
    return {
      sql: 'select column_name as name from information_schema.columns where table_schema = current_schema() and table_name = $1',
      bindings: [] as unknown[]
    }
  }

  compileIndexListing(_table: string) {
    return {
      sql: 'select indexname as name from pg_indexes where schemaname = current_schema() and tablename = $1',
      bindings: [] as unknown[]
    }
  }

  compileEnableForeignKeys(): string {
    return 'SET CONSTRAINTS ALL IMMEDIATE'
  }

  compileDisableForeignKeys(): string {
    return 'SET CONSTRAINTS ALL DEFERRED'
  }

  /**
   * `alter table t alter column "c" type …, alter column "c" set not null, …`.
   *
   * Postgres changes one property at a time, so the definition is taken apart
   * into a list of alterations that run as one statement. Nullability and the
   * default are always stated — dropping them when the new definition does not
   * mention them is what makes `change()` a replacement rather than a patch.
   *
   * `using` is emitted for the type change so a cast Postgres refuses to make
   * implicitly — text to integer, say — still goes through when the data allows
   * it, and fails loudly on the row that does not when it does not.
   */
  protected override compileChange(blueprint: Blueprint, column: ColumnAttributes): string[] {
    const table = this.wrapTable(blueprint.table)
    const name = this.wrap(column.name)
    const type = this.typeFor(column)

    const changes = [`alter column ${name} type ${type} using ${name}::${type}`]

    changes.push(
      `alter column ${name} ${column.nullable === true ? 'drop not null' : 'set not null'}`
    )

    changes.push(
      column.default === undefined
        ? `alter column ${name} drop default`
        : `alter column ${name} set default ${this.defaultValue(column.default)}`
    )

    return [`alter table ${table} ${changes.join(', ')}`]
  }
  /**
   * `create index … using gin (to_tsvector('english', col || ' ' || col))`.
   *
   * Postgres has no full-text *index type*: what makes a text search fast is a GIN
   * index over the `tsvector` the query will compute. The language matters and
   * cannot be guessed, so `english` is the default — an
   * application indexing another language wants its own `rawIndex`.
   */
  protected override compileFullText(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'fullText' }>
  ): string {
    const columns = command.columns
      .map((column) => `coalesce(${this.wrap(column)}, '')`)
      .join(" || ' ' || ")

    return `create index ${this.wrap(command.index)} on ${this.wrapTable(blueprint.table)} using gin (to_tsvector('english', ${columns}))`
  }

  protected override compileRenameIndex(_blueprint: Blueprint, from: string, to: string): string {
    // Postgres renames the index itself, not through the table it belongs to —
    // which is why the blueprint goes unread here and is read everywhere else.
    return `alter index ${this.wrap(from)} rename to ${this.wrap(to)}`
  }

  // ------------------------------------------------------------- inspection

  compileTables() {
    return {
      sql: `select tablename as name, schemaname as schema
            from pg_catalog.pg_tables
            where schemaname = current_schema()
            order by tablename`,
      bindings: [] as unknown[]
    }
  }

  compileViews() {
    return {
      sql: `select viewname as name, schemaname as schema, definition
            from pg_catalog.pg_views
            where schemaname = current_schema()
            order by viewname`,
      bindings: [] as unknown[]
    }
  }

  /**
   * `pg_attribute` rather than `information_schema.columns`.
   *
   * `format_type` gives the type as the server itself would write it —
   * `character varying(255)`, `numeric(8,2)` — which `information_schema`
   * spreads across four columns that have to be reassembled.
   */
  compileColumns(_table: string) {
    return {
      sql: `select a.attname as name,
                   format_type(a.atttypid, a.atttypmod) as type,
                   not a.attnotnull as nullable,
                   pg_get_expr(d.adbin, d.adrelid) as "default",
                   (a.attidentity <> '' or coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval%')
                     as auto_increment,
                   col_description(c.oid, a.attnum) as comment
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
            where c.relname = $1
              and c.relnamespace = current_schema()::regnamespace
              and a.attnum > 0 and not a.attisdropped
            order by a.attnum`,
      bindings: [] as unknown[]
    }
  }

  compileIndexes(_table: string) {
    return {
      sql: `select i.relname as name, ix.indisunique as "unique", ix.indisprimary as "primary",
                   a.attname as column_name, k.ord
            from pg_class c
            join pg_index ix on ix.indrelid = c.oid
            join pg_class i on i.oid = ix.indexrelid
            join lateral unnest(ix.indkey) with ordinality as k(attnum, ord) on true
            join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
            where c.relname = $1 and c.relnamespace = current_schema()::regnamespace
            order by i.relname, k.ord`,
      bindings: [] as unknown[]
    }
  }

  compileForeignKeys(_table: string) {
    return {
      sql: `select con.conname as name, a.attname as column_name, k.ord,
                   ft.relname as foreign_table, fa.attname as foreign_column,
                   con.confupdtype as on_update, con.confdeltype as on_delete
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
            join lateral unnest(con.conkey, con.confkey) with ordinality as k(att, fatt, ord) on true
            join pg_attribute a on a.attrelid = c.oid and a.attnum = k.att
            join pg_attribute fa on fa.attrelid = ft.oid and fa.attnum = k.fatt
            where con.contype = 'f'
              and c.relname = $1
              and c.relnamespace = current_schema()::regnamespace
            order by con.conname, k.ord`,
      bindings: [] as unknown[]
    }
  }

  mapColumns(rows: SchemaRow[]): ColumnInfo[] {
    return rows.map((row) => {
      const type = text(row.type)

      return {
        name: text(row.name),
        type,
        typeName: baseType(type),
        nullable: flag(row.nullable),
        default: nullableText(row.default),
        autoIncrement: flag(row.auto_increment),
        comment: nullableText(row.comment)
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
        primary: flag(group[0]?.primary)
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
        onUpdate: referentialAction(text(group[0]?.on_update)),
        onDelete: referentialAction(text(group[0]?.on_delete))
      })
    )
  }
}

/**
 * Postgres stores a referential action as one letter.
 *
 * `a` is the default and means no action, which is not the same as `restrict`:
 * one defers to the end of the statement and the other does not.
 */
function referentialAction(code: string): string | null {
  switch (code) {
    case 'a':
      return 'no action'
    case 'r':
      return 'restrict'
    case 'c':
      return 'cascade'
    case 'n':
      return 'set null'
    case 'd':
      return 'set default'
    default:
      return code === '' ? null : code
  }
}
