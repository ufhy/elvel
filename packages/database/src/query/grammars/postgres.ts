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

  /**
   * `on conflict (key) do update set … where "table"."guard" <= ?`
   *
   * The `where` on the update is what makes it a claim rather than a takeover: a
   * conflict with a row that is still alive updates nothing and reports zero.
   */
  override compileClaim(
    table: string,
    row: Record<string, unknown>,
    uniqueBy: string[],
    guard: string,
    alive: unknown
  ) {
    const insert = this.compileInsert(table, [row])
    const conflict = uniqueBy.map((column) => this.wrap(column)).join(', ')
    const assignments = Object.keys(row)
      .filter((column) => !uniqueBy.includes(column))
      .map((column) => `${this.wrap(column)} = excluded.${this.wrap(column)}`)
      .join(', ')

    // `parameter()`, not a literal `?`: Postgres numbers its placeholders and the
    // insert above has already used the first of them.
    return {
      sql:
        `${insert.sql} on conflict (${conflict}) do update set ${assignments} ` +
        `where ${this.wrapTable(table)}.${this.wrap(guard)} <= ${this.parameter(insert.bindings.length + 1)}`,
      bindings: [...insert.bindings, alive]
    }
  }

  override supportsReturning(): boolean {
    return true
  }

  /**
   * `jsonb_array_length((col->'a')::jsonb) > ?`.
   *
   * The path is walked with `->` rather than `->>`: the last step has to stay a
   * JSON value, and `->>` would hand `jsonb_array_length` a string.
   */
  protected override compileJsonLength(column: string, operator: string, value: string): string {
    const { column: field, path } = this.jsonPathParts(column)
    const walk = path.map((segment) => `->'${segment.replaceAll("'", "''")}'`).join('')

    // The column is cast before it is walked: a JSON document stored in a `text`
    // column has no `->` operator, which is the shape the schema builder writes
    // for `json()` on Postgres.
    return `jsonb_array_length((${super.wrap(field)})::jsonb${walk}) ${operator} ${value}`
  }

  /**
   * `col = jsonb_set(jsonb_set(col::jsonb, '{a}', ?::jsonb), '{b}', ?::jsonb)`.
   *
   * Nested rather than repeated as separate assignments: `set col = …, col = …`
   * would keep only the last one, and each call has to see what the one before
   * it wrote.
   *
   * The value is encoded to JSON text and cast, which is the only form that
   * stores a number as a number and a string as a string. Casting the column too
   * is what lets this work on a `json` column as well as a `jsonb` one.
   */
  protected override compileJsonUpdate(
    column: string,
    writes: Array<{ path: string[]; value: unknown }>,
    bindings: unknown[]
  ): string {
    const wrapped = super.wrap(column)
    let expression = `${wrapped}::jsonb`

    for (const { path, value } of writes) {
      const pointer = `'{${path.map((segment) => segment.replaceAll('"', '\\"')).join(',')}}'`

      bindings.push(JSON.stringify(value ?? null))

      /**
       * `($1::text)::jsonb`, not `$1::jsonb`.
       *
       * Bun's Postgres driver encodes a parameter it sees cast straight to
       * `jsonb`, so the JSON text `"dark"` arrives as `"\"dark\""` and an object
       * arrives as a string containing one. Going through `text` first makes the
       * driver send the bytes as written and Postgres do the parsing, which is
       * the only form that stores every shape correctly. Found by probing
       * `select ($1::jsonb)::text` against a real server.
       */
      expression = `jsonb_set(${expression}, ${pointer}, (${this.parameter(bindings.length)}::text)::jsonb)`
    }

    return `${wrapped} = ${expression}`
  }

  /**
   * pgvector's distance operators.
   *
   * The vector is bound as text and cast, for the same reason the JSON writes
   * are: Bun's driver would otherwise encode it, and `'[1,2,3]'` would arrive as
   * a quoted string rather than a vector literal.
   */
  protected override compileVectorDistance(column: string, metric: string, value: string): string {
    const operator = metric === 'cosine' ? '<=>' : metric === 'inner' ? '<#>' : '<->'

    return `(${super.wrap(column)} ${operator} (${value}::text)::vector)`
  }

  /**
   * `col::date = ?` for a date or a time, `extract(month from col) = ?` otherwise.
   *
   * Two forms because Postgres has both and they are not interchangeable: a cast
   * keeps the comparison against a date literal, while `extract` answers a number.
   * Laravel's Postgres grammar splits them the same way.
   */
  protected override compileDateWhere(
    part: 'date' | 'time' | 'day' | 'month' | 'year',
    column: string,
    operator: string,
    parameter: string
  ): string {
    if (part === 'date' || part === 'time') {
      return `${this.wrap(column)}::${part} ${operator} ${parameter}`
    }

    return `extract(${part} from ${this.wrap(column)}) ${operator} ${parameter}`
  }
}
