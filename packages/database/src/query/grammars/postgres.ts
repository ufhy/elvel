import { Grammar } from '../grammar.ts'

export class PostgresGrammar extends Grammar {
  /**
   * `("meta")::jsonb->'a'->>'b'` — `->>` only on the last hop, so the result is
   * text.
   *
   * The cast is not decoration: a JSON document in a `text` column — which is
   * what a portable migration writes, since SQLite has no JSON type — makes
   * `text ->> unknown` an unknown operator. `::jsonb` is a no-op on a real jsonb
   * column and a parse on anything else, so one form serves both. The dialect
   * suite caught this against a real Postgres.
   */
  protected override wrapJsonSelector(value: string): string {
    const { column, path } = this.jsonPathParts(value)
    const last = path[path.length - 1] as string
    const walk = path
      .slice(0, -1)
      .map((segment) => `->'${segment.replaceAll("'", "''")}'`)
      .join('')

    return `(${super.wrap(column)})::jsonb${walk}->>'${last.replaceAll("'", "''")}'`
  }

  protected override compileJsonContains(
    column: string,
    value: unknown,
    not: boolean,
    bindings: unknown[]
  ): string {
    const { column: field, path } = this.jsonPathParts(column)
    const walk = path.map((segment) => `->'${segment.replaceAll("'", "''")}'`).join('')

    /**
     * The **raw** value, unlike MySQL. Bun's Postgres driver JSON-encodes a
     * parameter itself when it is cast to jsonb, so stringifying here encodes it
     * twice — `'a'` arrives as the document `"\"a\""` and contains nothing. Found
     * by probing `select ($1::jsonb)::text` against a real server.
     */
    bindings.push(value)

    // Cast *before* walking: `text -> 'key'` is an unknown operator, so the walk
    // has to start from jsonb. `@>` is then jsonb containment.
    return `${not ? 'not ' : ''}(${super.wrap(field)})::jsonb${walk} @> ${this.parameter(bindings.length)}::jsonb`
  }

  /** `to_tsvector(...) @@ plainto_tsquery(?)` — no index required to be correct. */
  protected override compileFullText(
    columns: string[],
    value: string,
    bindings: unknown[]
  ): string {
    bindings.push(value)

    const vector = columns
      .map((column) => `to_tsvector('english', coalesce(${super.wrap(column)}, ''))`)
      .join(' || ')

    return `(${vector}) @@ plainto_tsquery('english', ${this.parameter(bindings.length)})`
  }

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
