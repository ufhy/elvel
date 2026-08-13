import { timingSafeEqual } from './cookies.ts'
import { currentScope } from './scope.ts'
import type { Session } from './session.ts'

/** Methods that cannot change state, so they need no token. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class TokenMismatchError extends Error {
  readonly status = 419

  constructor() {
    super('CSRF token mismatch.')
    this.name = 'TokenMismatchError'
  }
}

export type CsrfOptions = {
  /** Paths exempt from the check. `*` at the end matches a prefix. */
  except?: string[]
}

/**
 * Read the token a request presents.
 *
 * `_token` in the body, then `X-CSRF-TOKEN`. Laravel also accepts an encrypted
 * `X-XSRF-TOKEN`; that needs the encryption package, so it is not pretended
 * here — a caller sending only `X-XSRF-TOKEN` is rejected rather than waved
 * through.
 */
export function tokenFromRequest(
  body: unknown,
  headers: Record<string, string | undefined>
): string | undefined {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const field = (body as Record<string, unknown>)._token

    if (typeof field === 'string' && field !== '') return field
  }

  const header = headers['x-csrf-token'] ?? headers['X-CSRF-TOKEN']

  return typeof header === 'string' && header !== '' ? header : undefined
}

export function isReadRequest(method: string): boolean {
  return READ_METHODS.has(method.toUpperCase())
}

export function isExempt(path: string, except: string[] = []): boolean {
  return except.some((pattern) =>
    pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern
  )
}

/**
 * Compare the presented token with the session's, in constant time.
 *
 * Returns true for read requests and exempt paths, so the caller does not have
 * to repeat those conditions.
 */
export function tokensMatch(
  session: Session,
  options: {
    method: string
    path: string
    body?: unknown
    headers?: Record<string, string | undefined>
    except?: string[]
  }
): boolean {
  if (isReadRequest(options.method)) return true
  if (isExempt(options.path, options.except)) return true

  const presented = tokenFromRequest(options.body, options.headers ?? {})
  const expected = session.token()

  if (!presented || expected === '') return false

  return timingSafeEqual(presented, expected)
}

/**
 * The current request's CSRF token, read from the session in scope.
 *
 * A function rather than a prop, for the same reason `errors()` and `old()` are:
 * a form three components deep should not need the token threaded through every
 * one of them, and a form that silently omits it fails with a 419 that looks
 * like a framework bug.
 */
export function csrfToken(): string {
  return currentScope()?.session.token() ?? ''
}

/**
 * The hidden input every non-GET form needs — Blade's `@csrf`.
 *
 * ```tsx
 * <form method="post" action="/sign-in">
 *   {csrfField()}
 * </form>
 * ```
 *
 * Returned as markup rather than as a component so it can sit directly inside a
 * `<form>` without importing anything else. The value is the token itself, which
 * needs no escaping: it is generated as hex.
 */
export function csrfField(): string {
  return `<input type="hidden" name="_token" value="${csrfToken()}" />`
}
