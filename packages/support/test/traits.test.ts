import { describe, expect, test } from 'bun:test'
import { Conditionable } from '../src/traits.ts'

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
