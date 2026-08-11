import { Grammar } from '../grammar.ts'

export class MySqlGrammar extends Grammar {
  protected override quote = '`'

  // Widened so MariaDbGrammar can narrow it without breaking the contract.
  get dialect(): 'mysql' | 'mariadb' {
    return 'mysql'
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
