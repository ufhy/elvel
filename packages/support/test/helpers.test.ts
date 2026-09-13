import { afterEach, describe, expect, test } from 'bun:test'
import { Clock } from '../src/clock.ts'
import {
  blank,
  classBasename,
  filled,
  head,
  last,
  reportRescuedUsing,
  rescue,
  retry,
  tap,
  throwIf,
  throwUnless,
  transform,
  value
} from '../src/helpers.ts'
import { Sleep } from '../src/sleep.ts'
import { Conditionable } from '../src/traits.ts'

afterEach(() => {
  Sleep.restore()
  Clock.restore()
  reportRescuedUsing(() => undefined)
})

describe('value, tap and transform', () => {
  test('value resolves a function and passes anything else through', () => {
    expect(value(5)).toBe(5)
    expect(value(() => 5)).toBe(5)
  })

  test('tap returns the subject, not the callback', () => {
    const seen: number[] = []

    expect(tap(7, (n) => seen.push(n * 2))).toBe(7)
    expect(seen).toEqual([14])
  })

  test('transform skips a blank subject', () => {
    expect(transform('ada', (name) => name.toUpperCase())).toBe('ADA')
    expect(transform(null, (name: string) => name.toUpperCase(), 'none')).toBe('none')
    expect(transform('', (name: string) => name.toUpperCase(), 'none')).toBe('none')
  })
})

describe('blank and filled', () => {
  /** The reason this is not `!x`: both of these are answers. */
  test('zero and false are filled', () => {
    expect(blank(0)).toBe(false)
    expect(blank(false)).toBe(false)
    expect(filled(0)).toBe(true)
  })

  test('empty things are blank', () => {
    for (const empty of [null, undefined, '', '   ', [], {}, new Map(), new Set()]) {
      expect(blank(empty)).toBe(true)
    }
  })

  test('and non-empty ones are not', () => {
    for (const full of ['a', [1], { a: 1 }, new Map([[1, 1]])]) expect(filled(full)).toBe(true)
  })
})

describe('guards and small readers', () => {
  test('throwIf and throwUnless', () => {
    expect(() => throwIf(true, 'nope')).toThrow('nope')
    expect(() => throwIf(false, 'nope')).not.toThrow()
    expect(() => throwUnless(false, new TypeError('bad'))).toThrow(TypeError)
  })

  test('head and last', () => {
    expect(head([1, 2, 3])).toBe(1)
    expect(last([1, 2, 3])).toBe(3)
    expect(head([])).toBeUndefined()
  })

  test('classBasename reads an instance or a constructor', () => {
    class Article {}

    expect(classBasename(new Article())).toBe('Article')
    expect(classBasename(Article)).toBe('Article')
  })
})

describe('retry', () => {
  test('stops as soon as it succeeds', async () => {
    let calls = 0

    const result = await retry(3, () => {
      calls += 1

      if (calls < 2) throw new Error('flaky')

      return 'ok'
    })

    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  /** `times` is attempts, not retries. */
  test('three means the callback runs at most three times', async () => {
    let calls = 0

    await expect(
      retry(3, () => {
        calls += 1
        throw new Error('always')
      })
    ).rejects.toThrow('always')

    expect(calls).toBe(3)
  })

  test('the backoff is asserted rather than waited for', async () => {
    Sleep.fake()

    await expect(
      retry(
        4,
        () => {
          throw new Error('no')
        },
        { backoff: (attempt) => 100 * 2 ** (attempt - 1) }
      )
    ).rejects.toThrow('no')

    Sleep.assertSequence([100, 200, 400])
  })

  test('a fixed backoff is the shorthand', async () => {
    Sleep.fake()

    await expect(
      retry(
        3,
        () => {
          throw new Error('no')
        },
        50
      )
    ).rejects.toThrow()

    Sleep.assertSequence([50, 50])
  })

  test('`when` stops it early, so a 404 is not tried three times', async () => {
    let calls = 0

    await expect(
      retry(
        5,
        () => {
          calls += 1
          throw new Error('404')
        },
        { when: (error) => !(error as Error).message.includes('404') }
      )
    ).rejects.toThrow('404')

    expect(calls).toBe(1)
  })

  test('and it never sleeps after the last attempt', async () => {
    Sleep.fake()

    await expect(
      retry(
        1,
        () => {
          throw new Error('no')
        },
        100
      )
    ).rejects.toThrow()

    Sleep.assertNeverSlept()
  })
})

describe('rescue', () => {
  test('the fallback is returned and the failure is reported', () => {
    const reported: unknown[] = []
    reportRescuedUsing((error) => reported.push(error))

    const result = rescue(() => {
      throw new Error('boom')
    }, 'fallback')

    expect(result).toBe('fallback')
    expect((reported[0] as Error).message).toBe('boom')
  })

  test('a successful callback is untouched and nothing is reported', () => {
    const reported: unknown[] = []
    reportRescuedUsing((error) => reported.push(error))

    expect(rescue(() => 'fine', 'fallback')).toBe('fine')
    expect(reported).toEqual([])
  })

  test('an async callback rescues through the promise', async () => {
    const result = await rescue(async () => {
      throw new Error('boom')
    }, 'fallback')

    expect(result).toBe('fallback')
  })

  test('reporting can be turned off for the one call that means it', () => {
    const reported: unknown[] = []
    reportRescuedUsing((error) => reported.push(error))

    rescue(
      () => {
        throw new Error('expected')
      },
      null,
      { report: false }
    )

    expect(reported).toEqual([])
  })
})

describe('Conditionable', () => {
  class Box extends Conditionable {
    readonly seen: unknown[] = []

    add(value: unknown): this {
      this.seen.push(value)

      return this
    }
  }

  /** The trap: a function object is truthy, so this used to always run. */
  test('a function condition is called, not tested for truthiness', () => {
    const box = new Box()

    box.when(
      () => false,
      (self) => self.add('ran')
    )

    expect(box.seen).toEqual([])
  })

  test('and its result decides', () => {
    const box = new Box()

    box.when(
      () => true,
      (self) => self.add('ran')
    )

    expect(box.seen).toEqual(['ran'])
  })

  test('the resolved value reaches the callback', () => {
    const box = new Box()

    box.when('needle', (self, term) => self.add(term))

    expect(box.seen).toEqual(['needle'])
  })

  test('otherwise is the else branch', () => {
    const box = new Box()

    box.when(
      false,
      (self) => self.add('then'),
      (self) => self.add('else')
    )

    expect(box.seen).toEqual(['else'])
  })

  test('unless is the mirror, otherwise included', () => {
    const box = new Box()

    box.unless(
      () => false,
      (self) => self.add('ran')
    )
    box.unless(
      true,
      (self) => self.add('no'),
      (self) => self.add('else')
    )

    expect(box.seen).toEqual(['ran', 'else'])
  })

  test('and both still return the subject', () => {
    const box = new Box()

    expect(box.when(true, () => undefined)).toBe(box)
    expect(box.unless(true, () => undefined)).toBe(box)
  })
})
