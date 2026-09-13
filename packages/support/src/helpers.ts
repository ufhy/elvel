import { Sleep } from './sleep.ts'

/** A value, or a function that produces it. */
export type Lazy<T> = T | (() => T)

/** Resolve `Lazy`. Anything that is not a function is itself. */
export function value<T>(input: Lazy<T>, ...args: unknown[]): T {
  return typeof input === 'function' ? (input as (...a: unknown[]) => T)(...args) : input
}

/** Hand a value to a callback and return the value, not the callback's result. */
export function tap<T>(subject: T, callback: (subject: T) => unknown): T {
  callback(subject)

  return subject
}

/** `transform(x, fn)` — run `fn` unless `x` is blank, then return the default. */
export function transform<T, R>(subject: T, callback: (subject: NonNullable<T>) => R): R | undefined
export function transform<T, R, D>(
  subject: T,
  callback: (subject: NonNullable<T>) => R,
  fallback: Lazy<D>
): R | D
export function transform<T, R, D>(
  subject: T,
  callback: (subject: NonNullable<T>) => R,
  fallback?: Lazy<D>
): R | D | undefined {
  if (blank(subject)) return fallback === undefined ? undefined : value(fallback)

  return callback(subject as NonNullable<T>)
}

/**
 * Empty in the way a form field is empty: `null`, `undefined`, `''`, `[]`, `{}`.
 *
 * `0` and `false` are **not** blank, which is the whole reason this exists
 * rather than `!x` — a quantity of zero and an unchecked box are answers.
 */
export function blank(subject: unknown): boolean {
  if (subject === null || subject === undefined) return true
  if (typeof subject === 'string') return subject.trim().length === 0
  if (Array.isArray(subject)) return subject.length === 0
  if (subject instanceof Map || subject instanceof Set) return subject.size === 0
  if (typeof subject === 'object') return Object.keys(subject).length === 0

  return false
}

export function filled(subject: unknown): boolean {
  return !blank(subject)
}

/** Throw `error` when the condition holds. Reads better than an `if` in a guard. */
export function throwIf(condition: unknown, error: Error | string): void {
  if (!condition) return

  throw typeof error === 'string' ? new Error(error) : error
}

export function throwUnless(condition: unknown, error: Error | string): void {
  throwIf(!condition, error)
}

export function head<T>(items: readonly T[]): T | undefined {
  return items[0]
}

export function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1]
}

/** The class name of a value, or of a constructor. */
export function classBasename(subject: unknown): string {
  if (typeof subject === 'function') return subject.name

  return (subject as { constructor?: { name?: string } })?.constructor?.name ?? ''
}

export type RetryOptions = {
  /** Milliseconds between attempts, or a function of the attempt number. */
  backoff?: number | ((attempt: number) => number)
  /** Retry only when this says so. A `404` is not worth a second try. */
  when?: (error: unknown, attempt: number) => boolean | Promise<boolean>
}

/**
 * Run `callback`, retrying up to `times` attempts.
 *
 * The sleep goes through `Sleep`, so a test of the backoff asserts the sequence
 * instead of waiting for it.
 *
 * `times` is attempts, not retries: `retry(3, …)` calls the callback at most
 * three times. The off-by-one in the other reading is why it is spelt out.
 */
export async function retry<T>(
  times: number,
  callback: (attempt: number) => Promise<T> | T,
  options: RetryOptions | number = {}
): Promise<T> {
  const { backoff = 0, when } = typeof options === 'number' ? { backoff: options } : options
  const attempts = Math.max(1, times)

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callback(attempt)
    } catch (error) {
      lastError = error

      if (attempt >= attempts) break
      if (when && !(await when(error, attempt))) break

      const wait = typeof backoff === 'function' ? backoff(attempt) : backoff

      if (wait > 0) await Sleep.milliseconds(wait)
    }
  }

  throw lastError
}

export type RescueOptions = {
  /** Where a swallowed failure goes. Set once by the framework at boot. */
  report?: boolean
}

let reporter: ((error: unknown) => void) | undefined

/** Give `rescue` somewhere to report. The exception handler calls this at boot. */
export function reportRescuedUsing(callback: (error: unknown) => void): void {
  reporter = callback
}

/**
 * Run something, and carry on with a fallback if it throws.
 *
 * The failure is **reported** rather than dropped, which is the difference from
 * a bare `try`/`catch` — the four-line version everybody writes usually forgets
 * that half, and then the thing that broke is invisible.
 */
export function rescue<T, D = undefined>(
  callback: () => T,
  fallback?: Lazy<D>,
  options?: RescueOptions
): T | D
export function rescue<T, D = undefined>(
  callback: () => Promise<T>,
  fallback?: Lazy<D>,
  options?: RescueOptions
): Promise<T | D>
export function rescue<T, D>(
  callback: () => T | Promise<T>,
  fallback?: Lazy<D>,
  options: RescueOptions = {}
): T | D | Promise<T | D> {
  const recover = (error: unknown): D => {
    if (options.report !== false) reporter?.(error)

    return fallback === undefined ? (undefined as D) : value(fallback)
  }

  try {
    const result = callback()

    if (result instanceof Promise) return result.catch(recover)

    return result
  } catch (error) {
    return recover(error)
  }
}
