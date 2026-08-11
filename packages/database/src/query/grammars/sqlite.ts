import { Grammar } from '../grammar.ts'

export class SQLiteGrammar extends Grammar {
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
}
