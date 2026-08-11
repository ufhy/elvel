import { describe, expect, test } from 'bun:test'
import { Conditionable, Macroable } from '../src/traits.ts'

describe('Conditionable', () => {
  class Query extends Conditionable {
    readonly applied: string[] = []

    where(clause: string): this {
      this.applied.push(clause)
      return this
    }
  }

  test('when runs the callback only for truthy conditions', () => {
    const query = new Query()

    query
      .when(true, (self) => self.where('a'))
      .when(false, (self) => self.where('b'))
      .when(1, (self) => self.where('c'))
      .when(0, (self) => self.where('d'))
      .when('', (self) => self.where('e'))
      .when(undefined, (self) => self.where('f'))

    expect(query.applied).toEqual(['a', 'c'])
  })

  test('unless is the inverse', () => {
    const query = new Query()

    query.unless(false, (self) => self.where('a')).unless(true, (self) => self.where('b'))

    expect(query.applied).toEqual(['a'])
  })

  test('the chain keeps returning the same instance', () => {
    const query = new Query()

    expect(query.when(true, () => {})).toBe(query)
    expect(query.unless(true, () => {})).toBe(query)
    expect(query.tap(() => {})).toBe(query)
  })

  test('tap receives the instance', () => {
    const query = new Query()
    let captured: Query | undefined

    query.tap((self) => {
      captured = self
    })

    expect(captured).toBe(query)
  })
})

describe('Macroable', () => {
  /**
   * Regression guard: an auto-fix once rewrote `this` to `Macroable` inside these
   * static methods, which would install every macro on the shared base class.
   * These tests fail loudly if that ever happens again.
   */
  class Str extends Macroable {
    value = 'str'
  }

  class Arr extends Macroable {
    value = 'arr'
  }

  test('a macro lands on the subclass that declared it', () => {
    Str.macro('shout', function (this: Str) {
      return `${this.value}!`
    })

    // Macros are a runtime extension, so the call site needs a cast unless the
    // consuming project declares the method via interface merging.
    expect((new Str() as unknown as { shout(): string }).shout()).toBe('str!')
    expect(Str.hasMacro('shout')).toBe(true)
  })

  test('macros do not leak to sibling subclasses', () => {
    Str.macro('onlyOnStr', () => 'yes')

    expect(Arr.hasMacro('onlyOnStr')).toBe(false)
    expect((new Arr() as unknown as Record<string, unknown>).onlyOnStr).toBeUndefined()
  })

  test('the same macro name can differ per subclass', () => {
    Str.macro('describe', () => 'from Str')
    Arr.macro('describe', () => 'from Arr')

    expect((new Str() as unknown as { describe(): string }).describe()).toBe('from Str')
    expect((new Arr() as unknown as { describe(): string }).describe()).toBe('from Arr')
  })

  test('hasMacro reports unknown names as absent', () => {
    expect(Str.hasMacro('neverRegistered')).toBe(false)
  })

  test('macros are not enumerable, so they do not pollute spreads', () => {
    Str.macro('hidden', () => 'x')

    expect(Object.keys(Str.prototype)).not.toContain('hidden')
  })
})
