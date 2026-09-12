/**
 * Has the migration been run?
 *
 * The most likely first mistake, and it used to fail badly: the application
 * kept working — the recorder is not allowed to break it — while the log filled
 * with `no such table: lens_entries` once per request and the dashboard answered
 * 500 with a SQLite stack trace. Measured on the playground by dropping the
 * tables, not imagined.
 *
 * Recognised by message rather than by error class because each driver raises
 * its own, and `@elvel/lens` should not learn three of them by importing three
 * packages.
 */
const MISSING = [
  // SQLite
  'no such table',
  // Postgres
  'does not exist',
  // MySQL / MariaDB
  "doesn't exist",
  'ER_NO_SUCH_TABLE'
]

export function tableIsMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return MISSING.some((phrase) => message.includes(phrase))
}

/** What to tell somebody who has not run it. One sentence, and the two commands. */
export const NOT_INSTALLED =
  'Lens is enabled but its tables are not there. Run: elvel lens:table && elvel migrate'

/**
 * The same message as an error with no stack.
 *
 * A stack is where a failure came from, and this one came from a migration
 * nobody ran — every frame in it points at the recorder, which is not the
 * subject. Thirty lines of trace under a one-line instruction reads as a crash
 * and buries the instruction.
 */
export function notInstalledError(): Error {
  const error = new Error(NOT_INSTALLED)

  error.name = 'LensNotInstalled'
  error.stack = `LensNotInstalled: ${NOT_INSTALLED}`

  return error
}
