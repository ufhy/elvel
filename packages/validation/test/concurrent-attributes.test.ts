import { describe, expect, test } from 'bun:test'
import { Validator } from '../src/validator.ts'

/**
 * Attributes are validated together when any of their rules can wait.
 *
 * A form with `unique:` on three fields made three database round trips one after
 * another, and `active_url` can hold a DNS lookup for three seconds while every
 * attribute behind it waits its turn. Against Postgres on this machine, five
 * attributes with three `unique:` rules went from 0.149ms to 0.102ms — a round
 * trip is 39µs on loopback and rather more from anywhere else.
 *
 * What must not change is the answer, and the order it is reported in.
 */

/** A closure rule that takes `ms` and records when it ran, so overlap is visible. */
const slow = (ms: number, log: string[], name: string) => async (): Promise<true> => {
  log.push(`${name}:start`)
  await Bun.sleep(ms)
  log.push(`${name}:end`)

  return true
}

describe('attributes with a rule that can wait', () => {
  test('run together rather than in turn', async () => {
    const log: string[] = []

    const validator = new Validator({ a: 1, b: 2, c: 3 }, {
      a: [slow(30, log, 'a')],
      b: [slow(30, log, 'b')],
      c: [slow(30, log, 'c')]
    } as never)

    const startedAt = Date.now()

    expect<boolean>(await validator.passes()).toBe(true)

    // Three 30ms rules in sequence cannot finish in under 60ms.
    expect<boolean>(Date.now() - startedAt < 60).toBe(true)

    // And they overlapped: every one started before any had finished.
    expect<string[]>(log.slice(0, 3)).toEqual(['a:start', 'b:start', 'c:start'])
  })

  /**
   * The order errors are reported in is the order the fields were declared, not
   * the order the slowest rule came back. A form lists its errors down the page.
   */
  test('but report their failures in the order the rules were written', async () => {
    const failing = (ms: number, message: string) => async (): Promise<string> => {
      await Bun.sleep(ms)

      return message
    }

    const validator = new Validator({ first: 1, second: 2, third: 3 }, {
      // The slowest first, so a bag filled as answers arrive would invert them.
      first: [failing(40, 'first failed')],
      second: [failing(20, 'second failed')],
      third: [failing(1, 'third failed')]
    } as never)

    expect<boolean>(await validator.passes()).toBe(false)
    expect<string[]>(validator.errors.keys()).toEqual(['first', 'second', 'third'])
    expect<string | undefined>(validator.errors.first()).toBe('first failed')
    expect<string[]>(validator.errors.all()).toEqual([
      'first failed',
      'second failed',
      'third failed'
    ])
  })
})

describe('the rules that stop things still stop them', () => {
  /** `bail` stops one attribute, and only that one. */
  test('bail stops its own attribute and leaves the others alone', async () => {
    const validator = new Validator({ email: 'not-an-email', name: '' }, {
      email: 'bail|email|min:20|unique:nothing,nothing',
      name: 'required|min:5'
    } as never)

    expect<boolean>(await validator.passes()).toBe(false)
    expect<number>(validator.errors.get('email').length).toBe(1)
    expect<boolean>(validator.errors.has('name')).toBe(true)
  })

  /** An absent value reports "required" and nothing else. */
  test('an implicit failure still silences the rest of its attribute', async () => {
    const validator = new Validator({ other: 'x' }, {
      missing: 'required|min:5|email',
      other: 'required'
    } as never)

    expect<boolean>(await validator.passes()).toBe(false)
    expect<number>(validator.errors.get('missing').length).toBe(1)
  })

  /**
   * `stopOnFirstFailure` means the first attribute in declaration order, which is
   * a statement about order — so that path stays sequential.
   */
  test('stopOnFirstFailure reports the first field, not the fastest', async () => {
    const validator = new Validator({ a: '', b: '' }, { a: 'required', b: 'required' } as never, {
      stopOnFirstFailure: true
    })

    expect<boolean>(await validator.passes()).toBe(false)
    expect<string[]>(validator.errors.keys()).toEqual(['a'])
  })
})

describe('a form with nothing to wait for', () => {
  /** Runs sequentially: a task and a promise per attribute would be pure overhead. */
  test('still validates every attribute', async () => {
    const validator = new Validator({ name: 'Ada', age: 'nope', city: '' }, {
      name: 'required|string',
      age: 'required|numeric',
      city: 'required'
    } as never)

    expect<boolean>(await validator.passes()).toBe(false)
    expect<string[]>(validator.errors.keys()).toEqual(['age', 'city'])
  })
})
