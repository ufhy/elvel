import { Grammar } from '../grammar.ts'

export class MySqlGrammar extends Grammar {
  /**
   * `json_unquote(json_extract(...))` — unquoted, so `where meta->theme = 'dark'`
   * compares the string and not the JSON literal `"dark"`.
   */
  protected override wrapJsonSelector(value: string): string {
    const { column, path } = this.jsonPathParts(value)

    return `json_unquote(json_extract(${super.wrap(column)}, ${this.jsonPath(path)}))`
  }

  protected override compileJsonContains(
    column: string,
    value: unknown,
    not: boolean,
    bindings: unknown[]
  ): string {
    const { column: field, path } = this.jsonPathParts(column)

    // JSON-encoded: json_contains compares documents, not scalars.
    bindings.push(JSON.stringify(value))

    const pathArg = path.length > 0 ? `, ${this.jsonPath(path)}` : ''

    return `${not ? 'not ' : ''}json_contains(${super.wrap(field)}, ${this.parameter(bindings.length)}${pathArg})`
  }

  /** `match (...) against (? in natural language mode)` — needs a FULLTEXT index. */
  protected override compileFullText(
    columns: string[],
    value: string,
    bindings: unknown[]
  ): string {
    bindings.push(value)

    const wrapped = columns.map((column) => super.wrap(column)).join(', ')

    return `match (${wrapped}) against (${this.parameter(bindings.length)} in natural language mode)`
  }

  protected override quote = '`'

  // Widened so MariaDbGrammar can narrow it without breaking the contract.
  get dialect(): 'mysql' | 'mariadb' {
    return 'mysql'
  }

  /** MySQL rejects `default values`; the empty column list is the idiom. */
  protected override compileInsertDefaults(table: string): string {
    return `insert into ${this.wrapTable(table)} () values ()`
  }

  protected override compileLock(lock: 'update' | 'share'): string {
    return lock === 'update' ? 'for update' : 'lock in share mode'
  }

  override compileInsertOrIgnore(table: string, rows: Array<Record<string, unknown>>) {
    const insert = this.compileInsert(table, rows)

    return { ...insert, sql: insert.sql.replace('insert into', 'insert ignore into') }
  }

  /**
   * MySQL has no conflict target: `on duplicate key update` uses whichever
   * unique index the row collides with, so `uniqueBy` is unused here.
   */
  override compileUpsert(
    table: string,
    rows: Array<Record<string, unknown>>,
    _uniqueBy: string[],
    update: string[]
  ) {
    const insert = this.compileInsert(table, rows)
    const assignments = update
      .map((column) => `${this.wrap(column)} = values(${this.wrap(column)})`)
      .join(', ')

    return {
      sql: `${insert.sql} on duplicate key update ${assignments}`,
      bindings: insert.bindings
    }
  }

  /**
   * MySQL has no `where` on `on duplicate key update`, so the condition moves into
   * the assignments: each column is set to the new value when the row is dead and
   * to itself when it is alive.
   *
   * Assigning a column to itself changes nothing, and MySQL's affected-row count
   * says so — 1 for an insert, 2 for a real update, **0 when nothing changed**. So
   * a non-zero count means this caller won, the same answer the other dialects give.
   */
  override compileClaim(
    table: string,
    row: Record<string, unknown>,
    uniqueBy: string[],
    guard: string,
    alive: unknown
  ) {
    const insert = this.compileInsert(table, [row])
    const columns = Object.keys(row).filter((column) => !uniqueBy.includes(column))
    const bindings: unknown[] = [...insert.bindings]

    const assignments = columns
      .map((column) => {
        const wrapped = this.wrap(column)

        bindings.push(alive)

        return `${wrapped} = if(${this.wrap(guard)} <= ${this.parameter(bindings.length)}, values(${wrapped}), ${wrapped})`
      })
      .join(', ')

    return { sql: `${insert.sql} on duplicate key update ${assignments}`, bindings }
  }

  /** `json_length(col, '$."a"') > ?` — MySQL counts elements of an array. */
  protected override compileJsonLength(column: string, operator: string, value: string): string {
    const { column: field, path } = this.jsonPathParts(column)
    const target =
      path.length > 0 ? `${super.wrap(field)}, ${this.jsonPath(path)}` : super.wrap(field)

    return `json_length(${target}) ${operator} ${value}`
  }

  /**
   * `col = json_set(col, '$."a"', ?, '$."b"', ?)`.
   *
   * One call with every pair, because two `set col = …` assignments would leave
   * only the last one standing.
   *
   * An object or an array is cast rather than bound as text: without the cast
   * MySQL stores the JSON *string* inside the document, and the next read hands
   * back a string where an object was written.
   */
  protected override compileJsonUpdate(
    column: string,
    writes: Array<{ path: string[]; value: unknown }>,
    bindings: unknown[]
  ): string {
    const wrapped = super.wrap(column)
    const pairs: string[] = []

    for (const { path, value } of writes) {
      if (typeof value === 'boolean') {
        pairs.push(`${this.jsonPath(path)}, ${value ? 'true' : 'false'}`)

        continue
      }

      if (value !== null && typeof value === 'object') {
        bindings.push(JSON.stringify(value))
        pairs.push(`${this.jsonPath(path)}, cast(${this.parameter(bindings.length)} as json)`)

        continue
      }

      bindings.push(value ?? null)
      pairs.push(`${this.jsonPath(path)}, ${this.parameter(bindings.length)}`)
    }

    return `${wrapped} = json_set(${wrapped}, ${pairs.join(', ')})`
  }
}

export class MariaDbGrammar extends MySqlGrammar {
  override get dialect(): 'mariadb' {
    return 'mariadb'
  }

  override supportsReturning(): boolean {
    // MariaDB supports RETURNING on INSERT from 10.5.
    return true
  }
}
