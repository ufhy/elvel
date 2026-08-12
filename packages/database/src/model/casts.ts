export type CastType =
  | 'int'
  | 'integer'
  | 'float'
  | 'double'
  | 'boolean'
  | 'string'
  | 'json'
  | 'object'
  | 'array'
  | 'date'
  | 'datetime'
  | 'timestamp'

/**
 * Attribute casting.
 *
 * Databases hand back what their driver hands back: SQLite has no boolean, so
 * `active` arrives as `0`, and a JSON column arrives as a string. Casts make the
 * model's shape independent of that.
 */
export function castFromDatabase(value: unknown, cast: CastType): unknown {
  if (value === null || value === undefined) return value

  switch (cast) {
    case 'int':
    case 'integer':
      return typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)

    case 'float':
    case 'double':
      return typeof value === 'number' ? value : Number.parseFloat(String(value))

    case 'boolean':
      // `'0'` is truthy in JS, which is exactly the trap this exists to close.
      return value === true || value === 1 || value === '1' || value === 'true'

    case 'string':
      return String(value)

    case 'json':
    case 'object':
    case 'array':
      if (typeof value !== 'string') return value
      try {
        return JSON.parse(value)
      } catch {
        return value
      }

    case 'date':
    case 'datetime':
    case 'timestamp':
      return value instanceof Date ? value : new Date(String(value))

    default: {
      const exhaustive: never = cast
      throw new Error(`Unknown cast [${exhaustive}].`)
    }
  }
}

/** The inverse: turn a cast value back into something the driver accepts. */
export function castToDatabase(value: unknown, cast: CastType): unknown {
  if (value === null || value === undefined) return value

  switch (cast) {
    case 'json':
    case 'object':
    case 'array':
      return typeof value === 'string' ? value : JSON.stringify(value)

    case 'boolean':
      return value ? 1 : 0

    case 'date':
      return toDate(value).toISOString().slice(0, 10)

    case 'datetime':
    case 'timestamp':
      return formatDateTime(toDate(value))

    default:
      return value
  }
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

/**
 * `2026-08-11 14:30:00` — the format every dialect we target accepts, unlike an
 * ISO string with a `T` and a `Z`, which MySQL rejects.
 */
export function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')

  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}
