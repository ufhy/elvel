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
export const DEFAULT_BAG = 'default'

/**
 * The errors flashed into the session by the last request.
 *
 * `errors()` reads the default bag; `errors('login')` reads a named one, which is
 * what two forms on one page need — without names, the sign-up form's failures
 * would light up the sign-in form's fields.
 */
export function errors(bag: string = DEFAULT_BAG): MessageBag {
  const scope = currentScope()
  if (!scope) return new MessageBag()

  const flashed = scope.session.get<Record<string, unknown>>(ERRORS_KEY) ?? {}

  return new MessageBag(readBag(flashed, bag))
}

/** Which bags were flashed. Empty when the last request succeeded. */
export function errorBags(): string[] {
  const scope = currentScope()
  if (!scope) return []

  const flashed = scope.session.get<Record<string, unknown>>(ERRORS_KEY) ?? {}

  return isBagged(flashed)
    ? Object.keys(flashed[BAGGED] as object)
    : Object.keys(flashed).length > 0
      ? [DEFAULT_BAG]
      : []
}

/**
 * Marks a flashed value as holding several named bags.
 *
 * A sentinel rather than a shape test: a field genuinely called `default` must
 * not turn a plain bag into a bagged one.
 */
export const BAGGED = '__bags'

function isBagged(flashed: Record<string, unknown>): boolean {
  return typeof flashed[BAGGED] === 'object' && flashed[BAGGED] !== null
}

function readBag(flashed: Record<string, unknown>, bag: string): Record<string, string[]> {
  if (!isBagged(flashed)) {
    // No names in play: everything is the default bag, and a named read finds
    // nothing rather than accidentally matching a field.
    return bag === DEFAULT_BAG ? (flashed as Record<string, string[]>) : {}
  }

  const bags = flashed[BAGGED] as Record<string, Record<string, string[]>>

  return bags[bag] ?? {}
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

/**
 * Render something only when a field failed — Blade's `@error`.
 *
 * ```tsx
 * {whenError('email', (message) => <p class="error" safe>{message}</p>)}
 * ```
 *
 * The message is passed in rather than read again inside the callback, so the
 * check and the thing being shown cannot drift apart — the shape that reads
 * `errors().first('email')` twice will one day check one field and print another.
 *
 * **The callback output is not escaped.** JSX with `safe` on the element that
 * holds the message is the way to write this; interpolating the message into a
 * template string puts whatever was in the failing field into the page.
 */
export function whenError(
  field: string,
  render: (message: string) => string,
  bag: string = DEFAULT_BAG
): string {
  const message = errors(bag).first(field)

  return message === undefined ? '' : render(message)
}

/** Every message for a field, for a form that lists them all rather than the first. */
export function whenErrors(
  field: string,
  render: (messages: string[]) => string,
  bag: string = DEFAULT_BAG
): string {
  const messages = errors(bag).get(field)

  return messages.length === 0 ? '' : render(messages)
}
