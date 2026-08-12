import { currentScope } from './scope.ts'

/** The session keys these helpers read. Shared with `redirect()`. */
export const ERRORS_KEY = 'errors'
export const OLD_INPUT_KEY = '_old_input'

/**
 * Validation errors flashed by the *previous* request.
 *
 * Laravel's `$errors`, which is a `ViewErrorBag` shared into every template. Here
 * it is a function, because a JSX component has props rather than a scope — see
 * `scope.ts` for why that is not a workaround.
 *
 * Always answerable: with nothing flashed it is an empty bag, so a component can
 * ask `errors().first('email')` without first checking whether anything failed.
 */
export class MessageBag {
  constructor(private readonly messages: Record<string, string[]> = {}) {}

  /** Any errors at all, or any for one field. */
  has(field?: string): boolean {
    if (field === undefined) return Object.keys(this.messages).length > 0

    return (this.messages[field]?.length ?? 0) > 0
  }

  /** The first message for a field — what goes next to the input. */
  first(field?: string): string | undefined {
    if (field !== undefined) return this.messages[field]?.[0]

    for (const messages of Object.values(this.messages)) {
      if (messages[0] !== undefined) return messages[0]
    }

    return undefined
  }

  get(field: string): string[] {
    return [...(this.messages[field] ?? [])]
  }

  /** Every message, flattened — for a summary at the top of a form. */
  all(): string[] {
    return Object.values(this.messages).flat()
  }

  keys(): string[] {
    return Object.keys(this.messages)
  }

  count(): number {
    return this.all().length
  }

  isEmpty(): boolean {
    return !this.has()
  }

  toJSON(): Record<string, string[]> {
    return { ...this.messages }
  }
}

/**
 * The errors flashed into the session by the last request.
 *
 * ```tsx
 * <input name="email" value={old('email')} />
 * {errors().has('email') && <p class="error">{errors().first('email')}</p>}
 * ```
 */
export function errors(): MessageBag {
  const scope = currentScope()
  if (!scope) return new MessageBag()

  const flashed = scope.session.get<Record<string, string[]>>(ERRORS_KEY)

  return new MessageBag(flashed ?? {})
}

/**
 * What the user typed last time, so a rejected form does not come back blank.
 *
 * Refilling the form is not a nicety: a long form that empties itself on a
 * validation failure is one the user abandons.
 */
export function old<T = string>(field: string, fallback?: T): T | string {
  const scope = currentScope()
  if (!scope) return fallback ?? ''

  const input = scope.session.get<Record<string, unknown>>(OLD_INPUT_KEY) ?? {}
  const value = readPath(input, field)

  if (value === undefined || value === null) return fallback ?? ''

  return typeof value === 'string' ? value : (value as T)
}

/** True when anything was flashed for this field. */
export function hasOld(field: string): boolean {
  const scope = currentScope()
  if (!scope) return false

  const input = scope.session.get<Record<string, unknown>>(OLD_INPUT_KEY) ?? {}

  return readPath(input, field) !== undefined
}

/** `lines.0.sku`, so a repeated field can be refilled too. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source

  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}
