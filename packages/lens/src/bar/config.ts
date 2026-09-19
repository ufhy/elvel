import type { ApplicationContract } from '@elvel/contracts'

/** One allowlisted setting, as the bar draws it. */
export type ConfigLine = { key: string; value: string }

/**
 * The settings an application named, and nothing else.
 *
 * Debugbar ships a config collector and keeps it off, for a reason that has not
 * changed: configuration holds the application key, the mail password and every
 * database credential, and a bar draws into a page. So there is no "show the
 * config" switch here — there is a list of keys, and a key nobody wrote down is
 * not shown.
 *
 * A named key still cannot become a dump. `database.connections` is one key and
 * would print every password under it, so a value that is not a scalar is
 * described rather than printed: its shape, not its contents. An array of
 * scalars is the exception, because `app.locales` is the kind of thing worth
 * naming and holds nothing.
 */
export function configLines(app: ApplicationContract, keys: string[]): ConfigLine[] {
  return keys.map((key) => ({ key, value: describeValue(app.config.get(key)) }))
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'not set'
  if (value === null) return 'null'

  if (Array.isArray(value)) {
    return value.every(isScalar) ? value.map(String).join(', ') : `${value.length} items`
  }

  if (typeof value === 'object') {
    return `${Object.keys(value as object).length} keys`
  }

  return String(value)
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function')
}
