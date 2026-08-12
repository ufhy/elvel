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
  | 'encrypted'
  | 'encrypted:json'

/**
 * The encryption the `encrypted` casts need.
 *
 * Duck-typed and injected rather than imported: the database package must keep
 * working with no encryption package present, and only two casts need one.
 */
export type AttributeEncrypter = {
  encryptString(value: string, context?: string): string
  decryptString(payload: string, context?: string): string
}

let encrypter: AttributeEncrypter | undefined

/**
 * Give the casts an encrypter. Called by the encryption provider at boot.
 *
 * Synchronous on purpose, which is why the encrypter itself is: a cast runs inside
 * attribute access, and making that asynchronous would change every read of every
 * model.
 */
export function setAttributeEncrypter(instance: AttributeEncrypter | undefined): void {
  encrypter = instance
}

function requireEncrypter(cast: CastType): AttributeEncrypter {
  if (!encrypter) {
    throw new Error(`The [${cast}] cast needs an encrypter. Register EncryptionServiceProvider.`)
  }

  return encrypter
}

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
    case 'encrypted':
      return requireEncrypter(cast).decryptString(String(value))

    case 'encrypted:json':
      return JSON.parse(requireEncrypter(cast).decryptString(String(value)))

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
    case 'encrypted':
      return requireEncrypter(cast).encryptString(String(value))

    case 'encrypted:json':
      return requireEncrypter(cast).encryptString(JSON.stringify(value))

    case 'json':
    case 'object':
    case 'array':
      return typeof value === 'string' ? value : JSON.stringify(value)

    case 'boolean':
      // A real boolean, not 1/0: Postgres has a boolean type and refuses the
      // integer, while sqlite and mysql accept either and store 1/0 anyway.
      return Boolean(value)

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
