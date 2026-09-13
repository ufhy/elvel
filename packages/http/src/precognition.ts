import { CARRIES_RESPONSE } from '@elvel/core'

/**
 * Live, per-field validation without writing the rules twice.
 *
 * A front end wanting to validate a field as somebody types either posts the
 * whole form and hopes, or the rules are written again in JavaScript and drift.
 * The protocol is what avoids both: the client sends `Precognition: true`, the
 * server runs the request's validation and **stops before the handler**, and
 * answers `204` when everything the client asked about passed.
 *
 * `Precognition-Validate-Only: email,name` narrows it to the fields the user has
 * actually touched, which is what keeps a half-filled form from lighting up red.
 */
export const PRECOGNITION = 'precognition'
export const VALIDATE_ONLY = 'precognition-validate-only'

/** Is this a precognitive request? */
export function isPrecognitive(request: Request | undefined): boolean {
  return (request?.headers.get(PRECOGNITION) ?? '').toLowerCase() === 'true'
}

/** The fields the client asked about, or nothing for all of them. */
export function validateOnly(request: Request | undefined): string[] | undefined {
  const header = request?.headers.get(VALIDATE_ONLY)

  if (header === null || header === undefined || header.trim() === '') return undefined

  return header
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '')
}

/**
 * Keep only the rules the client asked about.
 *
 * A wildcard rule is kept when the field it expands to was asked for —
 * `items.*.price` answers a request for `items.0.price`, because the concrete
 * key is ours and not something the client ever wrote down.
 */
export function narrowRules<T extends Record<string, unknown>>(rules: T, fields: string[]): T {
  const wanted = new Set(fields)

  const kept = Object.entries(rules).filter(([key]) => {
    if (wanted.has(key)) return true

    const pattern = new RegExp(`^${key.split('*').map(escape).join('[^.]+')}$`)

    return fields.some((field) => pattern.test(field))
  })

  return Object.fromEntries(kept) as T
}

function escape(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The response a precognitive request gets when nothing failed.
 *
 * `204` and the header echoed back, so a client can tell a precognitive answer
 * from a real one — a proxy that stripped the request header would otherwise
 * make the client treat a completed action as a validation pass.
 */
export function precognitiveSuccess(): Response {
  return new Response(null, {
    status: 204,
    headers: { precognition: 'true', vary: `${PRECOGNITION}, ${VALIDATE_ONLY}` }
  })
}

/**
 * Stops the request here, carrying the `204`.
 *
 * Thrown rather than returned because the handler must not run: a precognitive
 * POST to "create an order" validates the order and creates nothing, and a
 * return value the caller could ignore would create it.
 */
export class PrecognitionSuccess extends Error {
  constructor() {
    super('Precognitive request validated.')
    this.name = 'PrecognitionSuccess'
  }

  /**
   * The symbol, not a `toResponse` method.
   *
   * Duck-typing that shape hijacked Elysia's own error classes once already —
   * see the note in `ExceptionHandler.render`.
   */
  [CARRIES_RESPONSE](): Response {
    return precognitiveSuccess()
  }
}
