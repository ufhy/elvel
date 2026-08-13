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
