/**
 * What the schema can be asked about itself.
 *
 * These shapes are the same on every dialect; the queries behind them are not,
 * and the mapping from one server's answer to one of these is the grammar's
 * job. Before this, three console commands each carried their own three
 * dialects of introspection SQL inline, where no application and no other
 * command could reach it.
 */

export type TableInfo = {
  name: string
  /** The schema or database it lives in, where the dialect reports one. */
  schema: string | null
}

export type ViewInfo = {
  name: string
  schema: string | null
  definition: string
}

export type ColumnInfo = {
  name: string
  /** As the server spells it: `varchar(255)`, `bigint unsigned`, `numeric(8,2)`. */
  type: string
  /** Just the type: `varchar`, `bigint`, `numeric`. */
  typeName: string
  nullable: boolean
  /** The default as SQL, not as a value — `nextval(…)` and `CURRENT_TIMESTAMP`. */
  default: string | null
  autoIncrement: boolean
  comment: string | null
}

export type IndexInfo = {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export type ForeignKeyInfo = {
  name: string
  columns: string[]
  foreignTable: string
  foreignColumns: string[]
  onUpdate: string | null
  onDelete: string | null
}

/**
 * A referential action, lowercased.
 *
 * SQLite answers `NO ACTION`, MySQL `CASCADE`, Postgres a single letter. A
 * caller comparing them should not have to know which server it is talking to.
 */
export function action(value: unknown): string | null {
  const text = nullableText(value)

  return text === null ? null : text.toLowerCase()
}

/** A row from any of the introspection queries, before the grammar maps it. */
export type SchemaRow = Record<string, unknown>

export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value)
}

/**
 * Truthy across three dialects.
 *
 * Postgres answers a boolean, MySQL a `0`/`1`, and SQLite either — the same
 * column read through a pragma and through `information_schema` does not agree
 * with itself.
 */
export function flag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0

  const text = String(value ?? '').toLowerCase()

  return text === '1' || text === 'true' || text === 'yes' || text === 't'
}

/** `varchar(255)` and `bigint unsigned` both name `varchar` and `bigint`. */
export function baseType(type: string): string {
  return (type.split('(')[0] ?? type).trim().split(' ')[0]?.toLowerCase() ?? ''
}

/**
 * Group rows that each carry one column of a multi-column index or key.
 *
 * Every dialect reports these one row per column, in order, and every one of
 * them needs the same fold.
 */
export function groupBy<T>(
  rows: SchemaRow[],
  key: (row: SchemaRow) => string,
  build: (name: string, rows: SchemaRow[]) => T
): T[] {
  const groups = new Map<string, SchemaRow[]>()

  for (const row of rows) {
    const name = key(row)
    const group = groups.get(name)

    if (group) group.push(row)
    else groups.set(name, [row])
  }

  return [...groups].map(([name, group]) => build(name, group))
}
