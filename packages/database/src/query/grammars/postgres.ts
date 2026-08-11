import { Grammar } from '../grammar.ts'

export class PostgresGrammar extends Grammar {
  get dialect(): 'postgres' {
    return 'postgres'
  }

  /**
   * Postgres wants numbered placeholders. PDO hides this from Laravel; Bun.SQL
   * does not, which is why placeholders belong to the grammar.
   */
  override parameter(index: number): string {
    return `$${index}`
  }

  protected override compileLock(lock: 'update' | 'share'): string {
    return lock === 'update' ? 'for update' : 'for share'
  }

  override compileTruncate(table: string): string[] {
    return [`truncate ${this.wrapTable(table)} restart identity cascade`]
  }

  override compileInsertOrIgnore(table: string, rows: Array<Record<string, unknown>>) {
    const insert = this.compileInsert(table, rows)

    return { ...insert, sql: `${insert.sql} on conflict do nothing` }
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
    return true
  }
}
