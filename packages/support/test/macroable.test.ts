import { afterEach, describe, expect, test } from 'bun:test'
import { Arr, Collection, Str } from '../src/index.ts'
import { Macroable, macroable } from '../src/macroable.ts'

/** A macro is a runtime extension, so a test reaches it through a cast. */
const as = <T>(value: unknown): T => value as T

describe('a class', () => {
  /**
   * Regression guard: an auto-fix once rewrote `this` to `Macroable` inside the
   * statics, which installs every macro on the shared base class.
   */
  class Left extends Macroable {
    value = 'left'
  }

  class Right extends Macroable {
    value = 'right'
  }

  afterEach(() => {
    Left.flushMacros()
    Right.flushMacros()
  })

  test('a macro lands on the subclass that declared it', () => {
    Left.macro('shout', function (this: Left) {
      return `${this.value}!`
    })

    expect(as<{ shout(): string }>(new Left()).shout()).toBe('left!')
    expect(Left.hasMacro('shout')).toBe(true)
  })

  test('and does not leak to a sibling', () => {
    Left.macro('only', () => 'yes')

    expect(Right.hasMacro('only')).toBe(false)
    expect(as<Record<string, unknown>>(new Right()).only).toBeUndefined()
  })

  test('the same name can differ per class', () => {
    Left.macro('which', () => 'left')
    Right.macro('which', () => 'right')

    expect(as<{ which(): string }>(new Left()).which()).toBe('left')
    expect(as<{ which(): string }>(new Right()).which()).toBe('right')
  })

  test('macros are not enumerable, so a spread does not carry them', () => {
    Left.macro('hidden', () => 'x')

    expect(Object.keys(Left.prototype)).not.toContain('hidden')
  })

  /** Or a macro named after a real method takes that method with it. */
  test('and a macro that shadowed a real method puts it back', () => {
    class Real extends Macroable {
      greet(): string {
        return 'real'
      }
    }

    Real.macro('greet', () => 'macro')

    expect(new Real().greet()).toBe('macro')

    Real.flushMacros()

    expect(new Real().greet()).toBe('real')
  })

  test('flushMacros removes them, so one test does not leak into the next', () => {
    Left.macro('temporary', () => 'x')
    Left.flushMacros()

    expect(Left.hasMacro('temporary')).toBe(false)
    expect(as<Record<string, unknown>>(new Left()).temporary).toBeUndefined()
  })
})

describe('an object of helpers', () => {
  const helpers = macroable({
    upper(value: string): string {
      return value.toUpperCase()
    }
  })

  afterEach(() => {
    helpers.flushMacros()
  })

  /** The half a prototype write cannot reach: `Str` and `Arr` are not classes. */
  test('is extended in place', () => {
    helpers.macro('exclaim', (value: string) => `${value}!`)

    expect(as<{ exclaim(value: string): string }>(helpers).exclaim('hi')).toBe('hi!')
    expect(helpers.hasMacro('exclaim')).toBe(true)
  })

  test('and its own helpers are untouched', () => {
    helpers.macro('exclaim', () => 'x')

    expect(helpers.upper('hi')).toBe('HI')
  })
})

describe('mixin', () => {
  class Target extends Macroable {}

  afterEach(() => {
    Target.flushMacros()
  })

  test('registers every method of a source at once', () => {
    Target.mixin({
      first: () => 'first',
      second: () => 'second'
    })

    expect(Target.hasMacro('first')).toBe(true)
    expect(as<{ second(): string }>(new Target()).second()).toBe('second')
  })

  test('takes a class as the source too', () => {
    class Extras {
      third(): string {
        return 'third'
      }
    }

    Target.mixin(Extras)

    expect(as<{ third(): string }>(new Target()).third()).toBe('third')
  })

  /** So a package's defaults do not overwrite what the application already added. */
  test('and can be told not to replace what is there', () => {
    Target.macro('kept', () => 'mine')
    Target.mixin({ kept: () => 'theirs' }, false)

    expect(as<{ kept(): string }>(new Target()).kept()).toBe('mine')
  })
})

describe('what the framework exposes', () => {
  afterEach(() => {
    Str.flushMacros()
    Arr.flushMacros()
    Collection.flushMacros()
  })

  test('Str', () => {
    Str.macro('shout', (value: string) => `${value.toUpperCase()}!`)

    expect(as<{ shout(value: string): string }>(Str).shout('hi')).toBe('HI!')
  })

  test('Arr', () => {
    Arr.macro('second', (items: unknown[]) => items[1])

    expect(as<{ second(items: unknown[]): unknown }>(Arr).second([1, 2, 3])).toBe(2)
  })

  test('Collection', () => {
    Collection.macro('total', function (this: Collection<number>) {
      return this.reduce((total: number, item: number) => total + item, 0)
    })

    expect(as<{ total(): number }>(Collection.make([1, 2, 3])).total()).toBe(6)
  })

  /** A macro on `Str` must not become a helper the fluent chain projects. */
  test('and a macro on Str is not spread onto the fluent chain', () => {
    Str.macro('shout', (value: string) => value)

    expect(Object.keys(Str)).not.toContain('shout')
  })
})
