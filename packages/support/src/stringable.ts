import { Str } from './str.ts'

/**
 * The fluent half of the string API — `Str.of(' Title ').trim().slug().limit(20)`.
 *
 * Written as a projection of `Str` rather than as 83 methods repeating it. Two
 * things fall out: a method added to `Str` is chainable the same day, and the
 * two can never disagree about what `limit` does.
 *
 * The mapped type below does the filtering. A `Str` entry whose first parameter
 * is the string becomes a method here with that parameter removed; one that does
 * not — `random(length)`, `uuid()` — is `never` and cannot be called, so the
 * chain never offers something that would take the subject as a length.
 */

type Fluent<T> = {
  [K in keyof T]: T[K] extends (value: string, ...rest: infer A) => infer R
    ? (...args: A) => R extends string ? Stringable : R
    : never
}

/**
 * Names the chain answers itself.
 *
 * `length` is the collision worth naming: `Str.length(value)` is a function and
 * `.length` here is a property, because that is what a native string has and
 * what every caller reaches for. The property wins; the function stays on `Str`.
 */
type Owned = 'length'

/** Entries the chain does not project. See `Owned`. */
const NOT_CHAINABLE = new Set<string>(['length'])

export class StringableBase {
  constructor(private readonly subject: string) {}

  /** The string itself. */
  toString(): string {
    return this.subject
  }

  valueOf(): string {
    return this.subject
  }

  toJSON(): string {
    return this.subject
  }

  get length(): number {
    return this.subject.length
  }

  /** Hand the whole thing to a function and keep chaining on what it returns. */
  pipe(callback: (value: string) => string): Stringable {
    return new StringableBase(callback(this.subject)) as Stringable
  }

  /** Look at it without changing it. */
  tap(callback: (value: string) => unknown): Stringable {
    callback(this.subject)

    return this as unknown as Stringable
  }

  /** Apply the callback only when the condition holds. */
  when(
    condition: boolean | ((value: Stringable) => boolean),
    callback: (value: Stringable) => Stringable,
    otherwise?: (value: Stringable) => Stringable
  ): Stringable {
    const self = this as unknown as Stringable
    const holds = typeof condition === 'function' ? condition(self) : condition

    if (holds) return callback(self)

    return otherwise ? otherwise(self) : self
  }

  unless(
    condition: boolean | ((value: Stringable) => boolean),
    callback: (value: Stringable) => Stringable,
    otherwise?: (value: Stringable) => Stringable
  ): Stringable {
    const self = this as unknown as Stringable
    const holds = typeof condition === 'function' ? condition(self) : condition

    return this.when(!holds, callback, otherwise)
  }

  whenEmpty(callback: (value: Stringable) => Stringable): Stringable {
    return this.when(this.subject.length === 0, callback)
  }

  whenNotEmpty(callback: (value: Stringable) => Stringable): Stringable {
    return this.when(this.subject.length > 0, callback)
  }

  isEmpty(): boolean {
    return this.subject.length === 0
  }

  isNotEmpty(): boolean {
    return this.subject.length > 0
  }

  /** Split into an array of `Stringable`, so the chain survives the split. */
  explode(separator: string | RegExp, limit?: number): Stringable[] {
    return this.subject.split(separator, limit).map((part) => of(part))
  }
}

export type Stringable = StringableBase & Omit<Fluent<typeof Str>, Owned>

/**
 * Projected on first use, not at import.
 *
 * Filling the prototype as a side effect of being imported would make
 * `"sideEffects": false` a lie, and `tests/side-effects.test.ts` says so. One
 * boolean check on the first `of()` costs nothing and keeps the claim true.
 */
let projected = false

function project(): void {
  if (projected) return

  projected = true

  for (const [name, entry] of Object.entries(Str)) {
    if (typeof entry !== 'function' || NOT_CHAINABLE.has(name)) continue
    if (name in StringableBase.prototype) continue

    Object.defineProperty(StringableBase.prototype, name, {
      value: function chained(this: StringableBase, ...args: unknown[]) {
        const result = (entry as (...a: unknown[]) => unknown)(this.toString(), ...args)

        // A string keeps the chain; a boolean, a number or an array ends it,
        // because that is the answer the caller asked for.
        return typeof result === 'string' ? of(result) : result
      },
      writable: true,
      configurable: true,
      enumerable: false
    })
  }
}

/** `Str.of(' Title ')`. */
export function of(value: string): Stringable {
  project()

  return new StringableBase(value) as Stringable
}
