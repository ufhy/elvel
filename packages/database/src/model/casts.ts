import { Collection } from '@elvel/support'
/**
 * A custom cast — `CastsAttributes`.
 *
 * `get` turns the stored value into what the attribute reads as; `set` turns an
 * assignment back into what the column stores. Both receive the model and the
 * whole attribute row, because a cast like Money may live in two columns.
 */
export interface CastsAttributes<TGet = unknown, TSet = unknown> {
  get(model: unknown, key: string, value: unknown, attributes: Record<string, unknown>): TGet
  set(model: unknown, key: string, value: TSet, attributes: Record<string, unknown>): unknown
}

/** A cast entry: a built-in name, a cast instance, or a class to construct. */
export type CastEntry = CastType | CastsAttributes | (new () => CastsAttributes)

/** Resolve a cast entry to an instance, or undefined for the built-in names. */
export function customCast(entry: CastEntry | undefined): CastsAttributes | undefined {
  if (entry === undefined || typeof entry === 'string') return undefined

  // A class is constructed once per call site; a cast must therefore be
  // stateless.
  return typeof entry === 'function' ? new entry() : entry
}

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
  | 'immutable_date'
  | 'immutable_datetime'
  | 'collection'
  | 'hashed'
  /** `decimal:2` — kept as a string, so no precision is lost on the way through. */
  | `decimal:${number}`

/**
 * The encryption the `encrypted` casts need.
 *
 * Duck-typed and injected rather than imported: the database package must keep
 * working with no encryption package present, and only two casts need one.
 */
export type AttributeEncrypter = {
  encryptString(value: string, context?: string): string
  decryptString(payload: string, context?: string): string
  /** A deterministic fingerprint, for a searchable index beside a ciphertext. */
  blindIndex?(value: string, context?: string): string
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

/** The injected encrypter, for the blind-index columns a model declares. */
export function attributeEncrypter(): AttributeEncrypter | undefined {
  return encrypter
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

    /**
     * The same value, frozen.
     *
     * A `Date` is mutable, so `order.shippedAt.setDate(1)` silently edits the
     * model's attribute and `isDirty()` never notices — the attribute and its
     * original are the same object. Freezing turns that into a thrown error at
     * the mutation rather than a wrong row at the write.
     */
    case 'immutable_date':
    case 'immutable_datetime':
      return Object.freeze(value instanceof Date ? new Date(value) : new Date(String(value)))

    /** A JSON array, handed back as a `Collection` so the chain survives. */
    case 'collection': {
      const parsed = typeof value === 'string' ? safeParse(value) : value

      return new Collection(Array.isArray(parsed) ? parsed : [])
    }

    /**
     * Read as it is stored.
     *
     * A hash is one-way: there is nothing to turn it back into. The cast exists
     * for the *write* side, which is where the value is hashed.
     */
    case 'hashed':
      return String(value)

    default:
      if (typeof cast === 'string' && cast.startsWith('decimal:')) {
        /**
         * A **string**, not a number.
         *
         * A money column read as a float is a rounding bug waiting for a large
         * enough number: `0.1 + 0.2` is the smallest version of the same
         * problem, and a total in cents is the version that reaches a customer.
         * The caller decides what to do with the digits.
         */
        return Number(value).toFixed(placesOf(cast))
      }

      throw new Error(`Unknown cast [${String(cast)}].`)
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

    case 'immutable_date':
      return toDate(value).toISOString().slice(0, 10)

    case 'immutable_datetime':
      return formatDateTime(toDate(value))

    case 'collection':
      return JSON.stringify(value instanceof Collection ? value.all() : value)

    /**
     * Hashed on the way in, and only if it is not already.
     *
     * Re-hashing a hash is the bug this guards: a model saved twice would
     * otherwise store the hash of its own hash, and the password would stop
     * matching without anything failing.
     */
    case 'hashed':
      return hashValue(String(value))

    default:
      if (typeof cast === 'string' && cast.startsWith('decimal:')) {
        return Number(value).toFixed(placesOf(cast))
      }

      return value
  }
}

/** The digits after the point in `decimal:2`. */
function placesOf(cast: string): number {
  const places = Number(cast.slice('decimal:'.length))

  return Number.isFinite(places) && places >= 0 ? places : 2
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * What the `hashed` cast hashes with.
 *
 * Injected rather than imported, for the reason the encrypter is: the database
 * package must keep working with no hashing package present, and one cast needs
 * one.
 */
type AttributeHasher = {
  /** Synchronous, because a cast is: see `makeSync` on the hashers. */
  makeSync(value: string): string
  isHashed(value: string): boolean
}

let hasher: AttributeHasher | undefined

export function setAttributeHasher(instance: AttributeHasher | undefined): void {
  hasher = instance
}

export function attributeHasher(): AttributeHasher | undefined {
  return hasher
}

function hashValue(value: string): string {
  if (!hasher) {
    throw new Error('The [hashed] cast needs a hasher. Register HashingServiceProvider.')
  }

  return hasher.isHashed(value) ? value : hasher.makeSync(value)
}

/**
 * `asEnum(Status)` — the cast that narrows.
 *
 * A string cast cannot: `'status': 'enum'` gives the attribute no type, which
 * is the one thing TypeScript could have checked. A custom cast can, so this is
 * a helper that builds one rather than another name in the union.
 */
export function asEnum<T extends string | number>(
  values: readonly T[] | Record<string, T>
): CastsAttributes<T | undefined, T> {
  const allowed = new Set<unknown>(Array.isArray(values) ? values : Object.values(values))

  return {
    get(_model, key, value) {
      if (value === null || value === undefined) return undefined

      // A column holding something outside the set is a migration that ran
      // against data the enum did not know about, and reading it as a valid
      // case would carry that mistake forward silently.
      if (!allowed.has(value)) {
        throw new Error(`[${key}] holds ${JSON.stringify(value)}, which is not one of the cases.`)
      }

      return value as T
    },

    set(_model, key, value) {
      if (value === null || value === undefined) return value

      if (!allowed.has(value)) {
        throw new Error(`[${key}] cannot be ${JSON.stringify(value)}: it is not one of the cases.`)
      }

      return value
    }
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
