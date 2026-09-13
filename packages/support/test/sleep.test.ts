import { afterEach, describe, expect, test } from 'bun:test'
import { Lottery, Timebox, timebox } from '../src/chance.ts'
import { Clock } from '../src/clock.ts'
import { Sleep } from '../src/sleep.ts'

afterEach(() => {
  Sleep.restore()
  Lottery.restore()
  Clock.restore()
})

describe('Sleep', () => {
  test('a real sleep actually waits', async () => {
    // Asserted explicitly: this test is about real time, so it must not inherit
    // a fake another file left behind.
    Sleep.restore()

    const started = Bun.nanoseconds()

    await Sleep.milliseconds(20)

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeGreaterThanOrEqual(15)
  })

  test('a faked one does not, and is recorded', async () => {
    Sleep.fake()

    const started = Bun.nanoseconds()
    await Sleep.seconds(30)

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeLessThan(50)
    expect(Sleep.slept()).toEqual([30_000])
  })

  test('the units convert', async () => {
    Sleep.fake()

    await Sleep.microseconds(500)
    await Sleep.milliseconds(2)
    await Sleep.seconds(1)
    await Sleep.minutes(1)
    await Sleep.hours(1)

    expect(Sleep.slept()).toEqual([0.5, 2, 1000, 60_000, 3_600_000])
  })

  test('and they add', async () => {
    Sleep.fake()

    await Sleep.seconds(1).and.milliseconds(500)

    expect(Sleep.slept()).toEqual([1500])
  })

  test('until a moment in the past sleeps not at all', async () => {
    Sleep.fake()

    await Sleep.until(Date.now() - 5000)

    expect(Sleep.slept()).toEqual([])
  })

  /** What a backoff is worth asserting: the shape, not one value. */
  test('assertSequence reads a whole backoff', async () => {
    Sleep.fake()

    for (const attempt of [1, 2, 3]) await Sleep.milliseconds(100 * 2 ** (attempt - 1))

    Sleep.assertSequence([100, 200, 400])
    expect(Sleep.total()).toBe(700)
  })

  test('a wrong sequence says what was slept instead', async () => {
    Sleep.fake()
    await Sleep.milliseconds(100)

    expect(() => Sleep.assertSequence([100, 200])).toThrow('got [100]')
  })

  test('assertSlept counts', async () => {
    Sleep.fake()
    await Sleep.milliseconds(50)
    await Sleep.milliseconds(50)

    Sleep.assertSlept(50, 2)
    expect(() => Sleep.assertSlept(50, 3)).toThrow('there were 2')
  })

  test('assertNeverSlept', () => {
    Sleep.fake()

    Sleep.assertNeverSlept()
  })

  test('restore takes real sleeps again', async () => {
    Sleep.fake()
    await Sleep.seconds(10)
    Sleep.restore()

    expect(Sleep.slept()).toEqual([])
  })
})

describe('Lottery', () => {
  test('always winning and always losing', () => {
    Lottery.alwaysWin()
    expect(Lottery.odds(1, 1_000_000).choose()).toBe(true)

    Lottery.alwaysLose()
    expect(Lottery.odds(999_999, 1_000_000).choose()).toBe(false)
  })

  test('the callbacks are what it answers with', () => {
    Lottery.alwaysWin()

    expect(
      Lottery.odds<string, string>(1, 2)
        .winner(() => 'won')
        .loser(() => 'lost')
        .choose()
    ).toBe('won')
  })

  test('a fixed sequence is consumed in order', () => {
    Lottery.fix([true, false, true])

    const draw = () => Lottery.odds(1, 2).choose()

    expect([draw(), draw(), draw()]).toEqual([true, false, true])
  })

  test('out of zero is an error rather than a division', () => {
    expect(() => Lottery.odds(1, 0)).toThrow('at least 1')
  })
})

describe('Timebox', () => {
  test('a fast callback still takes the window', async () => {
    const started = Bun.nanoseconds()

    await timebox(() => 'done', 60)

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeGreaterThanOrEqual(50)
  })

  test('a slow one is not made slower', async () => {
    const started = Bun.nanoseconds()

    await timebox(async () => {
      await Bun.sleep(40)
    }, 10)

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeLessThan(90)
  })

  /**
   * The whole point: a failure that escaped early would leak the timing the box
   * exists to hide.
   */
  test('a throw waits for the window before it escapes', async () => {
    const started = Bun.nanoseconds()

    await expect(
      timebox(() => {
        throw new Error('unknown address')
      }, 60)
    ).rejects.toThrow('unknown address')

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeGreaterThanOrEqual(50)
  })

  test('returnEarly is the opt-out, for a test', async () => {
    const started = Bun.nanoseconds()

    await new Timebox().returnEarly().call(() => 'done', 5000)

    expect((Bun.nanoseconds() - started) / 1_000_000).toBeLessThan(50)
  })
})

describe('Clock', () => {
  test('frozen time does not move', () => {
    Clock.freeze()
    const first = Clock.now()

    for (let spin = 0; spin < 100_000; spin += 1) Math.sqrt(spin)

    expect(Clock.now()).toBe(first)
    Clock.restore()
  })

  test('advance moves it, frozen or not', () => {
    Clock.freeze(1_000_000)
    Clock.advance(5000)
    expect(Clock.now()).toBe(1_005_000)

    Clock.restore()
    const before = Clock.now()
    Clock.advance(60_000)
    expect(Clock.now() - before).toBeGreaterThanOrEqual(59_000)
    Clock.restore()
  })

  test('at() puts it back afterwards', () => {
    const real = Clock.now()

    expect(Clock.at(0, () => Clock.now())).toBe(0)
    expect(Clock.isFrozen()).toBe(false)
    expect(Math.abs(Clock.now() - real)).toBeLessThan(1000)
  })

  /** The coupling that makes a faked sleep useful rather than a spin. */
  test('a faked sleep moves the clock', async () => {
    Clock.freeze(0)
    Sleep.fake()

    await Sleep.seconds(90)

    expect(Clock.now()).toBe(90_000)

    Sleep.restore()
    Clock.restore()
  })
})
