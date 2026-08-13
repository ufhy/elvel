import type { Blueprint, ColumnAttributes } from '../blueprint.ts'
import { type Modifier, SchemaGrammar } from '../grammar.ts'

export class PostgresSchemaGrammar extends SchemaGrammar {
  /** Verbatim from Laravel's PostgresGrammar. */
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
      case 'uuid':
        return 'uuid'
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

  /** Postgres has no unsigned integers; Laravel silently ignores the modifier. */
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
}
