/**
 * A driver error, with the statement that caused it.
 *
 * A failure arrived as whatever Bun's SQL client said and nothing else — so a
 * bad column name reached the log, and the Lens exception entry, as a syntax
 * error with no query attached. The SQL and the bindings are the two things
 * that make it actionable.
 */
export class QueryException extends Error {
  constructor(
    readonly sql: string,
    readonly bindings: unknown[],
    readonly previous: unknown,
    readonly connectionName?: string
  ) {
    super(`${messageOf(previous)} (SQL: ${sql})`)
    this.name = 'QueryException'

    // Kept, because the driver's own stack points at where it failed and this
    // one points at where it was wrapped.
    if (previous instanceof Error && previous.stack !== undefined) {
      this.stack = `${this.stack}\nCaused by: ${previous.stack}`
    }
  }

  /** The driver's own error, for a caller that needs to look at it. */
  override get cause(): unknown {
    return this.previous
  }
}

/**
 * A duplicate key, told apart from every other failure.
 *
 * The single class `createOrFirst()` is built on. Without it a race between two
 * requests inserting the same row can only be resolved by matching the driver's
 * message, and that message differs across SQLite, MySQL and Postgres — so
 * every application writes the same three-dialect string match.
 */
export class UniqueConstraintViolation extends QueryException {
  constructor(sql: string, bindings: unknown[], previous: unknown, connectionName?: string) {
    super(sql, bindings, previous, connectionName)
    this.name = 'UniqueConstraintViolation'
  }
}

/**
 * The three dialects' ways of saying "that key is taken".
 *
 * Matched on the driver's code first and its message second: a code is stable
 * and a message is translated, but Bun's client does not surface a code for
 * every driver, so the message is the fallback rather than the rule.
 *
 * - SQLite: `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY`
 * - MySQL: 1062, `ER_DUP_ENTRY`
 * - Postgres: `23505`, `unique_violation`
 */
export function isUniqueViolation(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  const errno = Number((error as { errno?: unknown } | null)?.errno ?? Number.NaN)

  if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE')) return true
  if (code.startsWith('SQLITE_CONSTRAINT_PRIMARYKEY')) return true
  if (code === '23505' || code === 'ER_DUP_ENTRY' || code === 'unique_violation') return true
  if (errno === 1062) return true

  const message = messageOf(error).toLowerCase()

  return (
    message.includes('unique constraint') ||
    message.includes('duplicate key') ||
    message.includes('duplicate entry') ||
    message.includes('unique violation')
  )
}

/** Wrap whatever the driver threw, choosing the more specific type where it fits. */
export function wrapQueryError(
  error: unknown,
  sql: string,
  bindings: unknown[],
  connectionName?: string
): QueryException {
  // Already wrapped — a nested call re-throwing is not a second failure.
  if (error instanceof QueryException) return error

  return isUniqueViolation(error)
    ? new UniqueConstraintViolation(sql, bindings, error, connectionName)
    : new QueryException(sql, bindings, error, connectionName)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message

  return String(error)
}
