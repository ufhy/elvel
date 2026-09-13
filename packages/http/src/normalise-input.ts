import { Elysia } from 'elysia'

export type NormaliseOptions = {
  /** Fields left exactly as they arrived. A password must never be trimmed. */
  except?: string[]
  /** Trim leading and trailing whitespace. */
  trim?: boolean
  /** `''` becomes `null`. */
  emptyToNull?: boolean
}

/**
 * Trim what came in, and turn an empty field into nothing.
 *
 * Both halves fix a bug that is invisible until it is not. A field submitted
 * with a trailing space is stored with it, and the `where('email', input)` that
 * looks it up later misses the row. An empty text input arrives as `''` rather
 * than `null`, so a nullable column gets an empty string and `nullable`
 * validation passes something the schema meant to be absent.
 *
 * `password` and `password_confirmation` are excepted by default and cannot
 * usefully be anything else: a password whose trailing space was trimmed on the
 * way in is a password nobody can type again.
 */
export function normaliseInputPlugin(options: NormaliseOptions = {}) {
  const except = new Set([...DEFAULT_EXCEPT, ...(options.except ?? [])])
  const trim = options.trim !== false
  const emptyToNull = options.emptyToNull !== false

  return new Elysia({ name: 'elvel/normalise-input' }).onTransform({ as: 'global' }, (context) => {
    const body = (context as { body?: unknown }).body

    if (isBag(body)) {
      ;(context as { body?: unknown }).body = normalise(body, except, trim, emptyToNull)
    }

    const query = (context as { query?: unknown }).query

    // The query string is read as often as the body and arrives the same way,
    // so leaving it alone would fix half the bug.
    if (isBag(query)) {
      ;(context as { query?: unknown }).query = normalise(query, except, trim, emptyToNull)
    }
  })
}

/** A password whose trailing space was trimmed is one nobody can type again. */
const DEFAULT_EXCEPT = ['password', 'password_confirmation', 'current_password']

function isBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Walks nested objects and arrays, because a form posts them.
 *
 * An excepted name is excepted at every depth: `items.0.password` is a password
 * wherever it sits, and a rule that only looked at the top level would trim it.
 */
export function normalise(
  value: unknown,
  except: Set<string>,
  trim: boolean,
  emptyToNull: boolean,
  key = ''
): unknown {
  if (except.has(key)) return value

  if (typeof value === 'string') {
    const trimmed = trim ? value.trim() : value

    return emptyToNull && trimmed === '' ? null : trimmed
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalise(entry, except, trim, emptyToNull, key))
  }

  // A `File` is an object and walking into it would replace an upload with a
  // plain record of its properties.
  if (!isBag(value) || value instanceof File || value instanceof Date) return value

  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      normalise(entry, except, trim, emptyToNull, name)
    ])
  )
}
