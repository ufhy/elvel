import { isExpression } from '../query/expression.ts'
import {
  Blueprint,
  type ColumnAttributes,
  type Command,
  type ForeignKeyAction
} from './blueprint.ts'

/** Modifier names, applied in the order each dialect declares. */
export type Modifier =
  | 'unsigned'
  | 'collate'
  | 'nullable'
  | 'default'
  | 'onUpdate'
  | 'increment'
  | 'comment'
  | 'after'
  | 'first'

/**
 * Compiles a `Blueprint` into DDL.
 *
 * The `modifiers` order is not cosmetic — it is taken verbatim from each of
 * Laravel's schema grammars, because SQL rejects the wrong order (SQLite wants
 * `primary key autoincrement` before `not null`, MySQL wants `unsigned` first).
 */
export abstract class SchemaGrammar {
  protected quote = '"'

  /** Column types that can carry an auto-incrementing key. */
  protected serials: string[] = [
    'bigInteger',
    'integer',
    'mediumInteger',
    'smallInteger',
    'tinyInteger'
  ]

  protected abstract modifiers: Modifier[]

  abstract typeFor(column: ColumnAttributes): string

  /**
   * Does changing a column mean rebuilding the table?
   *
   * True only for SQLite, which has no `alter column` at all. The builder asks
   * because the rebuild needs to read the current schema.
   */
  readonly rebuildsToChange: boolean = false

  /** One column as it would appear inside `create table (...)`. */
  columnDefinition(column: ColumnAttributes): string {
    return this.columnSql(new Blueprint(''), column)
  }

  /** Quote one identifier. Public so the builder can write a rebuild. */
  wrapColumn(value: string): string {
    return this.wrap(value)
  }

  wrap(value: string): string {
    if (value === '*') return value

    return value
      .split('.')
      .map(
        (segment) =>
          `${this.quote}${segment.replaceAll(this.quote, this.quote + this.quote)}${this.quote}`
      )
      .join('.')
  }

  wrapTable(table: string): string {
    return this.wrap(table)
  }

  columnize(columns: string[]): string {
    return columns.map((column) => this.wrap(column)).join(', ')
  }

  /** Every statement a blueprint compiles to, in execution order. */
  compile(blueprint: Blueprint): string[] {
    const statements: string[] = []

    for (const command of blueprint.commands) {
      switch (command.name) {
        case 'create':
          statements.push(this.compileCreate(blueprint))
          break
        case 'add':
          break
        case 'primary':
          if (!blueprint.creating) statements.push(this.compilePrimary(blueprint, command))
          break
        case 'unique':
          statements.push(this.compileUnique(blueprint, command))
          break
        case 'index':
          statements.push(this.compileIndex(blueprint, command))
          break
        case 'foreign':
          if (!blueprint.creating) statements.push(this.compileForeign(blueprint, command))
          break
        case 'dropColumn':
          statements.push(...this.compileDropColumn(blueprint, command))
          break
        case 'dropIndex':
          statements.push(this.compileDropIndex(blueprint, command.index))
          break
        case 'dropUnique':
          statements.push(this.compileDropUnique(blueprint, command.index))
          break
        case 'dropPrimary':
          statements.push(this.compileDropPrimary(blueprint, command.index))
          break
        case 'dropForeign':
          statements.push(this.compileDropForeign(blueprint, command.index))
          break
        case 'renameColumn':
          statements.push(this.compileRenameColumn(blueprint, command.from, command.to))
          break
        case 'rename':
          statements.push(
            `alter table ${this.wrapTable(blueprint.table)} rename to ${this.wrapTable(command.to)}`
          )
          break
        case 'drop':
          statements.push(`drop table ${this.wrapTable(blueprint.table)}`)
          break
        case 'dropIfExists':
          statements.push(`drop table if exists ${this.wrapTable(blueprint.table)}`)
          break
        default: {
          const exhaustive: never = command
          throw new Error(`Unsupported schema command: ${JSON.stringify(exhaustive)}`)
        }
      }
    }

    // Columns added to an existing table become ALTER statements; columns marked
    // `change()` are modifications of one that is already there.
    if (!blueprint.creating && blueprint.columns.length > 0) {
      const added = blueprint.columns.filter((column) => column.attributes.change !== true)
      const changed = blueprint.columns.filter((column) => column.attributes.change === true)

      for (const column of changed) {
        statements.unshift(...this.compileChange(blueprint, column.attributes))
      }

      if (added.length > 0) statements.unshift(...this.compileAdd(blueprint, added))
    }

    return statements
  }

  protected compileCreate(blueprint: Blueprint): string {
    const definitions = blueprint.columns.map((column) =>
      this.columnSql(blueprint, column.attributes)
    )
    const constraints = this.inlineConstraints(blueprint)
    const kind = blueprint.temporary ? 'create temporary table' : 'create table'

    return `${kind} ${this.wrapTable(blueprint.table)} (${[...definitions, ...constraints].join(', ')})`
  }

  /** Constraints that must live inside CREATE TABLE for this dialect. */
  protected inlineConstraints(blueprint: Blueprint): string[] {
    const constraints: string[] = []

    for (const command of blueprint.commands) {
      if (command.name === 'primary' && command.columns.length > 0) {
        constraints.push(`primary key (${this.columnize(command.columns)})`)
      }

      if (command.name === 'foreign') {
        constraints.push(this.foreignKeySql(command))
      }
    }

    return constraints
  }

  /**
   * Modify a column that already exists — `->change()`.
   *
   * Every engine spells this differently and one of them cannot do it at all, so
   * the base refuses rather than guessing. SQLite's answer is a whole-table
   * rebuild, which needs to read the current schema and therefore lives in the
   * builder rather than here.
   */
  protected compileChange(_blueprint: Blueprint, column: ColumnAttributes): string[] {
    throw new Error(`This database engine does not support changing a column (\`${column.name}\`).`)
  }

  protected compileAdd(blueprint: Blueprint, columns = blueprint.columns): string[] {
    return columns.map(
      (column) =>
        `alter table ${this.wrapTable(blueprint.table)} add column ${this.columnSql(blueprint, column.attributes)}`
    )
  }

  protected columnSql(blueprint: Blueprint, column: ColumnAttributes): string {
    let sql = `${this.wrap(column.name)} ${this.typeFor(column)}`

    for (const modifier of this.modifiers) {
      sql += this.applyModifier(modifier, blueprint, column)
    }

    return sql
  }

  protected applyModifier(
    modifier: Modifier,
    blueprint: Blueprint,
    column: ColumnAttributes
  ): string {
    switch (modifier) {
      case 'unsigned':
        return this.modifyUnsigned(column)
      case 'collate':
        return column.collation ? ` collate ${this.wrap(column.collation)}` : ''
      case 'nullable':
        return this.modifyNullable(column)
      case 'default':
        return this.modifyDefault(column)
      case 'onUpdate':
        return column.useCurrentOnUpdate ? ' on update current_timestamp' : ''
      case 'increment':
        return this.modifyIncrement(blueprint, column)
      case 'comment':
        return column.comment ? ` comment '${column.comment.replaceAll("'", "''")}'` : ''
      case 'after':
        return column.after ? ` after ${this.wrap(column.after)}` : ''
      case 'first':
        return column.first ? ' first' : ''
      default:
        return ''
    }
  }

  protected modifyUnsigned(_column: ColumnAttributes): string {
    return ''
  }

  protected modifyNullable(column: ColumnAttributes): string {
    return column.nullable ? ' null' : ' not null'
  }

  protected modifyDefault(column: ColumnAttributes): string {
    if (column.useCurrent) return ' default current_timestamp'
    if (column.default === undefined) return ''

    return ` default ${this.defaultValue(column.default)}`
  }

  protected defaultValue(value: unknown): string {
    if (isExpression(value)) return value.value
    if (value === null) return 'null'
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (typeof value === 'number') return String(value)

    return `'${String(value).replaceAll("'", "''")}'`
  }

  protected abstract modifyIncrement(blueprint: Blueprint, column: ColumnAttributes): string

  // ------------------------------------------------------------------ indexes

  protected compilePrimary(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'primary' }>
  ): string {
    return `alter table ${this.wrapTable(blueprint.table)} add primary key (${this.columnize(command.columns)})`
  }

  protected compileUnique(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'unique' }>
  ): string {
    return `create unique index ${this.wrap(command.index)} on ${this.wrapTable(blueprint.table)} (${this.columnize(command.columns)})`
  }

  protected compileIndex(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'index' }>
  ): string {
    return `create index ${this.wrap(command.index)} on ${this.wrapTable(blueprint.table)} (${this.columnize(command.columns)})`
  }

  protected foreignKeySql(command: Extract<Command, { name: 'foreign' }>): string {
    const parts = [
      `constraint ${this.wrap(command.index)} foreign key (${this.columnize(command.columns)})`,
      `references ${this.wrapTable(command.on)} (${this.columnize(command.references)})`
    ]

    if (command.onDelete) parts.push(`on delete ${command.onDelete}`)
    if (command.onUpdate) parts.push(`on update ${command.onUpdate}`)

    return parts.join(' ')
  }

  protected compileForeign(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'foreign' }>
  ): string {
    return `alter table ${this.wrapTable(blueprint.table)} add ${this.foreignKeySql(command)}`
  }

  protected compileDropColumn(
    blueprint: Blueprint,
    command: Extract<Command, { name: 'dropColumn' }>
  ): string[] {
    return command.columns.map(
      (column) => `alter table ${this.wrapTable(blueprint.table)} drop column ${this.wrap(column)}`
    )
  }

  protected compileDropIndex(_blueprint: Blueprint, index: string): string {
    return `drop index ${this.wrap(index)}`
  }

  protected compileDropUnique(blueprint: Blueprint, index: string): string {
    return this.compileDropIndex(blueprint, index)
  }

  protected compileDropPrimary(blueprint: Blueprint, _index?: string): string {
    return `alter table ${this.wrapTable(blueprint.table)} drop constraint ${this.wrap(`${blueprint.table}_pkey`)}`
  }

  protected compileDropForeign(blueprint: Blueprint, index: string): string {
    return `alter table ${this.wrapTable(blueprint.table)} drop constraint ${this.wrap(index)}`
  }

  protected compileRenameColumn(blueprint: Blueprint, from: string, to: string): string {
    return `alter table ${this.wrapTable(blueprint.table)} rename column ${this.wrap(from)} to ${this.wrap(to)}`
  }

  // ------------------------------------------------------------- inspection

  abstract compileTableExists(): { sql: string; bindings: unknown[] }

  abstract compileColumnListing(table: string): { sql: string; bindings: unknown[] }

  /**
   * Index names on a table.
   *
   * Three different places to look: SQLite keeps them in a pragma, MySQL in
   * `information_schema.statistics`, Postgres in `pg_indexes`. There is no
   * portable query, which is why this is a grammar method rather than one SQL
   * string in the builder.
   */
  abstract compileIndexListing(table: string): { sql: string; bindings: unknown[] }

  /** Column name in the result of `compileIndexListing`. */
  get indexListingKey(): string {
    return 'name'
  }

  /** Column name in the result of `compileColumnListing`. */
  columnListingKey = 'name'

  abstract compileEnableForeignKeys(): string

  abstract compileDisableForeignKeys(): string

  foreignKeyActionOf(action: ForeignKeyAction): string {
    return action ?? 'no action'
  }
}
