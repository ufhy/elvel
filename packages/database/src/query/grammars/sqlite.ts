import { Grammar } from '../grammar.ts'

export class SQLiteGrammar extends Grammar {
  /** `json_extract("meta", '$."theme"')` — SQLite's one JSON accessor. */
  protected override wrapJsonSelector(value: string): string {
    const { column, path } = this.jsonPathParts(value)

    return `json_extract(${super.wrap(column)}, ${this.jsonPath(path)})`
  }

  /**
   * `exists (select 1 from json_each(...) where value is ?)`.
   *
   * SQLite has no `json_contains`; walking the array with `json_each` is what
   * Laravel's grammar does too. `is` rather than `=`, so a null element can match.
   */
  protected override compileJsonContains(
    column: string,
    value: unknown,
    not: boolean,
    bindings: unknown[]
  ): string {
    const { column: field, path } = this.jsonPathParts(column)
    const target =
      path.length > 0
        ? `json_extract(${super.wrap(field)}, ${this.jsonPath(path)})`
        : super.wrap(field)

    // The raw value, not JSON-encoded: json_each yields scalars.
    bindings.push(value)

    return `${not ? 'not ' : ''}exists (select 1 from json_each(${target}) where json_each.value is ${this.parameter(bindings.length)})`
  }

  get dialect(): 'sqlite' {
    return 'sqlite'
  }

  /** SQLite has no TRUNCATE; Laravel deletes the rows and resets the sequence. */
  override compileTruncate(table: string): string[] {
    return [
      `delete from sqlite_sequence where name = '${table}'`,
      `delete from ${this.wrapTable(table)}`
    ]
  }

  override compileInsertOrIgnore(table: string, rows: Array<Record<string, unknown>>) {
    const insert = this.compileInsert(table, rows)

    return { ...insert, sql: insert.sql.replace('insert into', 'insert or ignore into') }
  }

  override compileUpsert(
    table: string,
    rows: Array<Record<string, unknown>>,
    uniqueBy: string[],
    update: string[]
  ) {
    const insert = this.compileInsert(table, rows)
    const conflict = uniqueBy.map((column) => this.wrap(column)).join(', ')
    const assignments = update
      .map((column) => `${this.wrap(column)} = excluded.${this.wrap(column)}`)
      .join(', ')

    return {
      sql: `${insert.sql} on conflict (${conflict}) do update set ${assignments}`,
      bindings: insert.bindings
    }
  }

  override supportsReturning(): boolean {
    // RETURNING landed in SQLite 3.35; Bun ships a newer build.
    return true
  }

  /** `json_array_length(col, '$."a"') > ?`. */
  protected override compileJsonLength(column: string, operator: string, value: string): string {
    const { column: field, path } = this.jsonPathParts(column)
    const target =
      path.length > 0 ? `${super.wrap(field)}, ${this.jsonPath(path)}` : super.wrap(field)

    return `json_array_length(${target}) ${operator} ${value}`
  }

  /**
   * `col = json_set(ifnull(col, json('{}')), '$."a"', json(?), '$."b"', json(?))`.
   *
   * One call with every pair: two `set col = …` assignments would keep only the
   * last, so the first key written would vanish.
   *
   * `json(?)` rather than a bare parameter, so an object or an array is stored as
   * a document instead of as a string containing one. A scalar goes the same way
   * — `json('"dark"')` is the string `dark` — which keeps one code path instead
   * of a type switch that would eventually miss a case.
   *
   * `ifnull(col, json('{}'))` because `json_set(null, …)` is null: without it,
   * writing a key into a column that has never been set silently erases it.
   */
  protected override compileJsonUpdate(
    column: string,
    writes: Array<{ path: string[]; value: unknown }>,
    bindings: unknown[]
  ): string {
    const wrapped = super.wrap(column)
    const pairs: string[] = []

    for (const { path, value } of writes) {
      bindings.push(JSON.stringify(value ?? null))
      pairs.push(`${this.jsonPath(path)}, json(${this.parameter(bindings.length)})`)
    }

    return `${wrapped} = json_set(ifnull(${wrapped}, json('{}')), ${pairs.join(', ')})`
  }
}
