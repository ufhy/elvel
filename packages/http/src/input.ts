import { Arr, Collection } from '@elvel/support'
import { currentScope } from './scope.ts'

export type InputData = Record<string, unknown>

/**
 * Reading a request's input, with the coercion every application writes anyway.
 *
 * A handler holds the Web `Request` and whatever Elysia parsed, and a payload is
 * `unknown` at runtime however it was typed at the call site. `boolean()` is the
 * one every form needs: an unchecked checkbox is **absent**, a checked one is
 * `"on"`, and `"0"` is false — three rules that are wrong in a different way
 * each time somebody writes them again.
 */
export class InputBag {
  constructor(private readonly data: InputData = {}) {}

  all(): InputData {
    return { ...this.data }
  }

  keys(): string[] {
    return Object.keys(this.data)
  }

  /** Dot access, so `input('address.city')` reads a nested payload. */
  input<T = unknown>(key: string): T | undefined
  input<T>(key: string, fallback: T): T
  input<T>(key: string, fallback?: T): T | undefined {
    return Arr.get(this.data, key, fallback as T)
  }

  has(...keys: string[]): boolean {
    return keys.every((key) => Arr.has(this.data, key))
  }

  hasAny(...keys: string[]): boolean {
    return keys.some((key) => Arr.has(this.data, key))
  }

  /** Present and not empty. `''`, `[]` and `null` are not filled. */
  filled(...keys: string[]): boolean {
    return keys.every((key) => isFilled(Arr.get(this.data, key)))
  }

  isNotFilled(...keys: string[]): boolean {
    return keys.every((key) => !isFilled(Arr.get(this.data, key)))
  }

  missing(...keys: string[]): boolean {
    return !this.has(...keys)
  }

  only(keys: string[]): InputData {
    const out: InputData = {}

    for (const key of keys) {
      if (Arr.has(this.data, key)) Arr.set(out, key, Arr.get(this.data, key))
    }

    return out
  }

  except(keys: string[]): InputData {
    const out = structuredCloneish(this.data)

    for (const key of keys) Arr.forget(out, key)

    return out
  }

  collect(key?: string): Collection<unknown> {
    const value = key === undefined ? Object.values(this.data) : Arr.get(this.data, key)

    return new Collection(Array.isArray(value) ? value : value === undefined ? [] : [value])
  }

  merge(values: InputData): this {
    Object.assign(this.data, values)

    return this
  }

  /** How a default is supplied without overwriting what the caller sent. */
  mergeIfMissing(values: InputData): this {
    for (const [key, value] of Object.entries(values)) {
      if (!Arr.has(this.data, key)) this.data[key] = value
    }

    return this
  }

  whenHas<T>(key: string, then: (value: unknown) => T, otherwise?: () => T): T | undefined {
    if (Arr.has(this.data, key)) return then(Arr.get(this.data, key))

    return otherwise?.()
  }

  whenFilled<T>(key: string, then: (value: unknown) => T, otherwise?: () => T): T | undefined {
    const value = Arr.get(this.data, key)

    if (isFilled(value)) return then(value)

    return otherwise?.()
  }

  // ----------------------------------------------------------------- readers

  string(key: string, fallback = ''): string {
    const value = Arr.get<unknown>(this.data, key)

    if (value === undefined || value === null) return fallback

    return String(value)
  }

  /**
   * An unchecked checkbox is absent, a checked one is `"on"`, and `"0"` is false.
   *
   * Missing is `false` rather than an error, because that is what a form means
   * by leaving a box alone — and it is the one place a strict reader would be
   * wrong on every submission.
   */
  boolean(key: string, fallback = false): boolean {
    const value = Arr.get<unknown>(this.data, key)

    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0

    return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase())
  }

  integer(key: string, fallback = 0): number {
    const value = this.number(key)

    return value === undefined || !Number.isInteger(value) ? fallback : value
  }

  float(key: string, fallback = 0): number {
    return this.number(key) ?? fallback
  }

  /** `undefined` for anything that is not a date, so a caller can tell. */
  date(key: string, fallback?: Date): Date | undefined {
    const value = Arr.get<unknown>(this.data, key)

    if (value instanceof Date) return value
    if (value === undefined || value === null || value === '') return fallback

    const parsed = new Date(String(value))

    return Number.isNaN(parsed.getTime()) ? fallback : parsed
  }

  /**
   * One of these, or nothing.
   *
   * Nothing rather than the first case: a payload naming a value outside the set
   * is a caller sending something we do not serve, and quietly picking a default
   * for it is how that becomes an order in the wrong state.
   */
  enum<T extends string>(key: string, cases: readonly T[]): T | undefined {
    const value = this.string(key)

    return cases.includes(value as T) ? (value as T) : undefined
  }

  array<T = unknown>(key: string, fallback: T[] = []): T[] {
    const value = Arr.get<unknown>(this.data, key)

    if (Array.isArray(value)) return value as T[]

    return value === undefined || value === null ? fallback : ([value] as T[])
  }

  private number(key: string): number | undefined {
    const value = Arr.get<unknown>(this.data, key)

    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'string' || value.trim() === '') return undefined

    const parsed = Number(value)

    return Number.isFinite(parsed) ? parsed : undefined
  }
}

/** `''`, `[]`, `{}` and `null` are not filled; `0` and `false` are. */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0

  return true
}

/** A shallow-enough copy that `except` can delete from it without mutating. */
function structuredCloneish(data: InputData): InputData {
  return JSON.parse(JSON.stringify(data)) as InputData
}

/** What a handler context carries that this can read. */
export type InputSource = {
  body?: unknown
  query?: Record<string, unknown>
  request?: Request
}

/**
 * The request's input — query string and parsed body, body winning.
 *
 * Pass the handler context, or nothing inside a request and the scope answers.
 * The body wins because a route that takes both means the body: a query string
 * on a POST is where a caller puts what the URL is about, not what it is
 * sending.
 */
export function inputs(source?: InputSource): InputBag {
  const from = source ?? currentScope()
  const url = from?.request === undefined ? undefined : new URL(from.request.url)

  const query: InputData = {
    ...(url === undefined ? {} : Object.fromEntries(url.searchParams)),
    ...((source?.query ?? {}) as InputData)
  }

  const body = source?.body

  return new InputBag({
    ...query,
    ...(typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as InputData)
      : {})
  })
}
