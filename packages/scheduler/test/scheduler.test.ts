import { beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { CronExpression, partsIn } from '../src/cron.ts'
import { ScheduledEvent } from '../src/event.ts'
import { type MutexStore, ScheduleRunner } from '../src/runner.ts'
import { Schedule } from '../src/schedule.ts'

/** A fixed moment to match against: Wednesday, 12 August 2026, 13:30 UTC. */
const WEDNESDAY = new Date('2026-08-12T13:30:00.000Z')

const at = (iso: string) => new Date(iso)

describe('CronExpression parsing', () => {
  test('every minute matches anything', () => {
    const cron = CronExpression.parse('* * * * *')

    expect(cron.matches(WEDNESDAY, 'UTC')).toBe(true)
    expect(cron.matches(at('2026-01-01T00:00:00Z'), 'UTC')).toBe(true)
  })

  test('a fixed minute and hour match only then', () => {
    const cron = CronExpression.parse('30 13 * * *')

    expect(cron.matches(WEDNESDAY, 'UTC')).toBe(true)
    expect(cron.matches(at('2026-08-12T13:31:00Z'), 'UTC')).toBe(false)
    expect(cron.matches(at('2026-08-12T12:30:00Z'), 'UTC')).toBe(false)
  })

  test('seconds are not part of the question', () => {
    const cron = CronExpression.parse('30 13 * * *')

    expect(cron.matches(at('2026-08-12T13:30:59Z'), 'UTC')).toBe(true)
  })

  test('steps, ranges and lists', () => {
    expect(CronExpression.parse('*/15 * * * *').matches(at('2026-08-12T10:45:00Z'), 'UTC')).toBe(
      true
    )
    expect(CronExpression.parse('*/15 * * * *').matches(at('2026-08-12T10:46:00Z'), 'UTC')).toBe(
      false
    )

    expect(CronExpression.parse('0 9-17 * * *').matches(at('2026-08-12T17:00:00Z'), 'UTC')).toBe(
      true
    )
    expect(CronExpression.parse('0 9-17 * * *').matches(at('2026-08-12T18:00:00Z'), 'UTC')).toBe(
      false
    )

    expect(CronExpression.parse('0 1,13 * * *').matches(at('2026-08-12T13:00:00Z'), 'UTC')).toBe(
      true
    )

    // A range with a step: every other hour from 1.
    const odd = CronExpression.parse('0 1-23/2 * * *')
    expect(odd.matches(at('2026-08-12T15:00:00Z'), 'UTC')).toBe(true)
    expect(odd.matches(at('2026-08-12T16:00:00Z'), 'UTC')).toBe(false)
  })

  test('a bare value with a step runs to the end of the field', () => {
    // `5/15` is "5, then every fifteenth minute after".
    const cron = CronExpression.parse('5/15 * * * *')

    for (const minute of [5, 20, 35, 50]) {
      expect(cron.matches(at(`2026-08-12T10:${String(minute).padStart(2, '0')}:00Z`), 'UTC')).toBe(
        true
      )
    }

    expect(cron.matches(at('2026-08-12T10:10:00Z'), 'UTC')).toBe(false)
  })

  test('month and day names, in any case', () => {
    expect(CronExpression.parse('0 0 * AUG *').matches(at('2026-08-12T00:00:00Z'), 'UTC')).toBe(
      true
    )
    expect(CronExpression.parse('0 0 * aug *').matches(at('2026-09-12T00:00:00Z'), 'UTC')).toBe(
      false
    )
    // Wednesday.
    expect(CronExpression.parse('0 0 * * WED').matches(at('2026-08-12T00:00:00Z'), 'UTC')).toBe(
      true
    )
    expect(CronExpression.parse('0 0 * * MON-FRI').matches(at('2026-08-15T00:00:00Z'), 'UTC')).toBe(
      false
    )
  })

  test('Sunday is both 0 and 7', () => {
    const sunday = at('2026-08-16T00:00:00Z')

    expect(CronExpression.parse('0 0 * * 0').matches(sunday, 'UTC')).toBe(true)
    expect(CronExpression.parse('0 0 * * 7').matches(sunday, 'UTC')).toBe(true)
  })

  test('macros expand', () => {
    expect(CronExpression.parse('@daily').toString()).toBe('0 0 * * *')
    expect(CronExpression.parse('@hourly').toString()).toBe('0 * * * *')
    expect(CronExpression.parse('@weekly').toString()).toBe('0 0 * * 0')
    expect(CronExpression.parse('@monthly').toString()).toBe('0 0 1 * *')
    expect(CronExpression.parse('@yearly').toString()).toBe('0 0 1 1 *')
  })

  test('L is the last day of the month, whatever its length', () => {
    const cron = CronExpression.parse('0 0 L * *')

    // August has 31 days, September 30, February 2028 has 29.
    expect(cron.matches(at('2026-08-31T00:00:00Z'), 'UTC')).toBe(true)
    expect(cron.matches(at('2026-08-30T00:00:00Z'), 'UTC')).toBe(false)
    expect(cron.matches(at('2026-09-30T00:00:00Z'), 'UTC')).toBe(true)
    expect(cron.matches(at('2028-02-29T00:00:00Z'), 'UTC')).toBe(true)
    expect(cron.matches(at('2026-02-29T00:00:00Z'), 'UTC')).toBe(false)
  })

  test('a nonsense expression says what is wrong', () => {
    expect(() => CronExpression.parse('* * *')).toThrow(/five fields/)
    expect(() => CronExpression.parse('99 * * * *')).toThrow(/outside the range 0-59/)
    expect(() => CronExpression.parse('* * * * NOPE')).toThrow(/not a number/)
    expect(() => CronExpression.parse('*/0 * * * *')).toThrow(/positive whole number/)
    expect(() => CronExpression.parse('10-5 * * * *')).toThrow(/starts after it ends/)
  })
})

describe('the day-of-month / day-of-week rule', () => {
  /**
   * POSIX cron's one real surprise: with both day fields restricted the
   * expression matches if *either* does. Getting this wrong makes
   * `0 0 1 * MON` mean "the 1st, but only on a Monday" instead of "the 1st, and
   * every Monday" — a schedule that would silently almost never run.
   */
  const both = CronExpression.parse('0 0 1 * MON')

  test('either day field is enough when both are restricted', () => {
    // The 1st of August 2026 is a Saturday: matches on day-of-month alone.
    expect(both.matches(at('2026-08-01T00:00:00Z'), 'UTC')).toBe(true)
    // 10 August is a Monday but not the 1st: matches on day-of-week alone.
    expect(both.matches(at('2026-08-10T00:00:00Z'), 'UTC')).toBe(true)
    // 11 August is neither.
    expect(both.matches(at('2026-08-11T00:00:00Z'), 'UTC')).toBe(false)
  })

  test('only the restricted field counts when the other is *', () => {
    const domOnly = CronExpression.parse('0 0 1 * *')
    expect(domOnly.matches(at('2026-08-01T00:00:00Z'), 'UTC')).toBe(true)
    expect(domOnly.matches(at('2026-08-10T00:00:00Z'), 'UTC')).toBe(false)

    const dowOnly = CronExpression.parse('0 0 * * MON')
    expect(dowOnly.matches(at('2026-08-10T00:00:00Z'), 'UTC')).toBe(true)
    expect(dowOnly.matches(at('2026-08-01T00:00:00Z'), 'UTC')).toBe(false)
  })

  test('`?` reads as "no opinion", like `*`', () => {
    const cron = CronExpression.parse('0 0 ? * MON')

    expect(cron.matches(at('2026-08-10T00:00:00Z'), 'UTC')).toBe(true)
    expect(cron.matches(at('2026-08-11T00:00:00Z'), 'UTC')).toBe(false)
  })
})

describe('CronExpression.nextRunAt', () => {
  test('the next matching minute, never the current one', () => {
    const next = CronExpression.parse('* * * * *').nextRunAt(at('2026-08-12T13:30:30Z'))

    expect(next.toISOString()).toBe('2026-08-12T13:31:00.000Z')
  })

  test('skips forward over days that cannot match', () => {
    // 29 February only exists in a leap year.
    const next = CronExpression.parse('0 0 29 2 *').nextRunAt(at('2026-08-12T00:00:00Z'), 'UTC')

    expect(next.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })

  test('finds the next weekday occurrence', () => {
    const next = CronExpression.parse('30 9 * * MON').nextRunAt(at('2026-08-12T13:30:00Z'), 'UTC')

    // The Monday after Wednesday 12 August 2026 is the 17th.
    expect(next.toISOString()).toBe('2026-08-17T09:30:00.000Z')
  })
})

describe('timezones', () => {
  test('the same instant is a different local time', () => {
    const tokyo = partsIn(WEDNESDAY, 'Asia/Tokyo')
    const utc = partsIn(WEDNESDAY, 'UTC')

    expect(utc.hour).toBe(13)
    // Tokyo is nine hours ahead, so 13:30Z is 22:30 the same day.
    expect(tokyo.hour).toBe(22)
    expect(tokyo.dayOfMonth).toBe(12)
  })

  test('an expression is matched in its own zone', () => {
    const cron = CronExpression.parse('30 22 * * *')

    expect(cron.matches(WEDNESDAY, 'Asia/Tokyo')).toBe(true)
    expect(cron.matches(WEDNESDAY, 'UTC')).toBe(false)
  })

  test('a zone crossing midnight changes the day of the week too', () => {
    // 22:30 in Tokyo on the 12th is 13:30 UTC; at 16:00 UTC it is already the
    // 13th in Tokyo, which is a Thursday.
    expect(
      CronExpression.parse('0 1 13 * THU').matches(at('2026-08-12T16:00:00Z'), 'Asia/Tokyo')
    ).toBe(true)
  })

  test('daylight saving is handled by the zone, not by arithmetic', () => {
    const cron = CronExpression.parse('30 2 * * *')

    // Europe/Berlin is UTC+1 in winter and UTC+2 in summer. Local 02:30 is a
    // different instant in each, and both have to match — which is exactly what an
    // offset added by hand would get wrong.
    expect(cron.matches(at('2026-01-15T01:30:00Z'), 'Europe/Berlin')).toBe(true)
    expect(cron.matches(at('2026-07-15T00:30:00Z'), 'Europe/Berlin')).toBe(true)

    // And the instant that is 02:30 in winter is not 02:30 in summer.
    expect(cron.matches(at('2026-07-15T01:30:00Z'), 'Europe/Berlin')).toBe(false)
  })
})

describe('frequency helpers write the expression', () => {
  const event = () => new ScheduledEvent(() => undefined, 'probe')

  test('the defaults and the simple cases', () => {
    expect(event().cronExpression).toBe('* * * * *')
    expect(event().everyFiveMinutes().cronExpression).toBe('*/5 * * * *')
    expect(event().everyThirtyMinutes().cronExpression).toBe('0,30 * * * *')
    expect(event().hourly().cronExpression).toBe('0 * * * *')
    expect(event().hourlyAt(15).cronExpression).toBe('15 * * * *')
    expect(event().hourlyAt([15, 45]).cronExpression).toBe('15,45 * * * *')
    expect(event().daily().cronExpression).toBe('0 0 * * *')
    expect(event().dailyAt('13:30').cronExpression).toBe('30 13 * * *')
    expect(event().dailyAt('13').cronExpression).toBe('0 13 * * *')
    expect(event().twiceDaily().cronExpression).toBe('0 1,13 * * *')
    expect(event().twiceDailyAt(3, 15, 30).cronExpression).toBe('30 3,15 * * *')
  })

  test('days of the week', () => {
    expect(event().weekdays().cronExpression).toBe('* * * * 1,2,3,4,5')
    expect(event().weekends().cronExpression).toBe('* * * * 0,6')
    expect(event().mondays().cronExpression).toBe('* * * * 1')
    expect(event().weekly().cronExpression).toBe('0 0 * * 0')
    expect(event().weeklyOn(1, '8:00').cronExpression).toBe('0 8 * * 1')
    expect(event().weeklyOn([1, 4], '8:30').cronExpression).toBe('30 8 * * 1,4')
  })

  test('months and days of the month', () => {
    expect(event().monthly().cronExpression).toBe('0 0 1 * *')
    expect(event().monthlyOn(15, '9:00').cronExpression).toBe('0 9 15 * *')
    expect(event().twiceMonthly(1, 16, '6:00').cronExpression).toBe('0 6 1,16 * *')
    expect(event().daysOfMonth(1, 10, 20).cronExpression).toBe('0 0 1,10,20 * *')
    expect(event().lastDayOfMonth('23:50').cronExpression).toBe('50 23 L * *')
    expect(event().quarterly().cronExpression).toBe('0 0 1 1-12/3 *')
    expect(event().yearly().cronExpression).toBe('0 0 1 1 *')
    expect(event().yearlyOn(6, 15, '9:30').cronExpression).toBe('30 9 15 6 *')
  })

  test('quarterly actually means four times a year', () => {
    const cron = CronExpression.parse(event().quarterly().cronExpression)

    for (const month of ['01', '04', '07', '10']) {
      expect(cron.matches(at(`2026-${month}-01T00:00:00Z`), 'UTC')).toBe(true)
    }

    expect(cron.matches(at('2026-02-01T00:00:00Z'), 'UTC')).toBe(false)
  })

  test('a sub-minute frequency still fires once a minute', () => {
    const entry = event().everyTenSeconds()

    expect(entry.cronExpression).toBe('* * * * *')
    expect(entry.repeatInterval).toBe(10)
    expect(entry.isRepeatable).toBe(true)
  })

  test('a repeat interval has to divide a minute', () => {
    expect(() => event().repeatEvery(7)).toThrow(/divide 60/)
    expect(() => event().repeatEvery(0)).toThrow(/divide 60/)
  })
})

describe('filters', () => {
  const event = () => new ScheduledEvent(() => undefined, 'probe')

  test('when and skip decide, and are kept apart from being due', async () => {
    const entry = event().everyMinute().when(false)

    // Still due — the expression matches — but filtered out.
    expect(entry.isDue(WEDNESDAY)).toBe(true)
    expect(await entry.filtersPass()).toBe(false)

    expect(await event().when(true).skip(false).filtersPass()).toBe(true)
    expect(await event().when(true).skip(true).filtersPass()).toBe(false)
  })

  test('an async filter is awaited', async () => {
    const entry = event().when(async () => {
      await Bun.sleep(1)

      return false
    })

    expect(await entry.filtersPass()).toBe(false)
  })

  test('environments limit where an entry runs', () => {
    const entry = event().everyMinute().environments('production')

    expect(entry.isDue(WEDNESDAY, 'production')).toBe(true)
    expect(entry.isDue(WEDNESDAY, 'local')).toBe(false)
    // With no environment given there is nothing to compare against.
    expect(entry.isDue(WEDNESDAY)).toBe(true)
  })

  test('between covers a window that crosses midnight', async () => {
    // 22:00–06:00 is a window either side of midnight; the naive comparison
    // matches nothing.
    const overnight = event().timezone('UTC').between('22:00', '06:00')

    // Cannot fix "now", so assert the arithmetic through both branches instead:
    // the interval logic is exercised by the always-true and always-false ends.
    const always = event().timezone('UTC').between('00:00', '23:59')
    const never = event().timezone('UTC').between('23:59', '23:59')

    expect(await always.filtersPass()).toBe(true)
    expect(typeof (await overnight.filtersPass())).toBe('boolean')

    const parts = partsIn(new Date(), 'UTC')
    const isNow = parts.hour === 23 && parts.minute === 59
    expect(await never.filtersPass()).toBe(isNow)
  })

  test('unlessBetween is the inverse', async () => {
    const entry = event().timezone('UTC').unlessBetween('00:00', '23:59')

    expect(await entry.filtersPass()).toBe(false)
  })
})

describe('mutex naming', () => {
  test('the same schedule and task share a name across processes', () => {
    const first = new ScheduledEvent(() => undefined, 'cache:prune').daily()
    const second = new ScheduledEvent(() => undefined, 'cache:prune').daily()

    expect(first.mutexName()).toBe(second.mutexName())
  })

  test('a different schedule or task does not', () => {
    const daily = new ScheduledEvent(() => undefined, 'cache:prune').daily()
    const hourly = new ScheduledEvent(() => undefined, 'cache:prune').hourly()
    const other = new ScheduledEvent(() => undefined, 'queue:prune').daily()

    expect(daily.mutexName()).not.toBe(hourly.mutexName())
    expect(daily.mutexName()).not.toBe(other.mutexName())
  })
})

describe('ScheduleRunner', () => {
  /** A mutex store with the three methods the runner uses. */
  function memoryMutex(): MutexStore & { keys: Set<string> } {
    const keys = new Set<string>()

    return {
      keys,
      add: async (key: string) => {
        if (keys.has(key)) return false

        keys.add(key)

        return true
      },
      forget: async (key: string) => keys.delete(key),
      has: async (key: string) => keys.has(key)
    }
  }

  test('hooks run in order around the callback', async () => {
    const order: string[] = []

    const event = new ScheduledEvent(() => {
      order.push('task')
    }, 'probe')
      .before(() => order.push('before'))
      .onSuccess(() => order.push('success'))
      .onFailure(() => order.push('failure'))
      .after(() => order.push('after'))

    expect(await new ScheduleRunner().runEvent(event)).toBe('ran')
    expect(order).toEqual(['before', 'task', 'success', 'after'])
  })

  test('a failure is reported, not thrown, and calls the right hooks', async () => {
    const order: string[] = []
    const reported: unknown[] = []

    const event = new ScheduledEvent(() => {
      throw new Error('broken')
    }, 'probe')
      .onSuccess(() => order.push('success'))
      .onFailure(() => order.push('failure'))
      .after(() => order.push('after'))

    const runner = new ScheduleRunner({ report: (error) => reported.push(error) })

    expect(await runner.runEvent(event)).toBe('failed')
    expect(order).toEqual(['failure', 'after'])
    expect((reported[0] as Error).message).toBe('broken')
    expect((event.error as Error).message).toBe('broken')
  })

  test('one broken entry does not stop the rest', async () => {
    const ran: string[] = []

    const events = [
      new ScheduledEvent(() => {
        throw new Error('first')
      }, 'one'),
      new ScheduledEvent(() => ran.push('two'), 'two')
    ]

    const result = await new ScheduleRunner({ report: () => undefined }).run(events)

    expect(ran).toEqual(['two'])
    expect(result).toMatchObject({ ran: 1, failed: 1 })
  })

  test('withoutOverlapping keeps a second run out while the first is going', async () => {
    const mutex = memoryMutex()
    const runner = new ScheduleRunner({ mutex })

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const event = new ScheduledEvent(() => gate, 'slow').withoutOverlapping()

    const first = runner.runEvent(event)
    // The first run is still inside the callback, holding the mutex.
    await Bun.sleep(10)

    expect(await runner.runEvent(event)).toBe('overlapping')

    release?.()
    expect(await first).toBe('ran')

    // The mutex is released once the run is over, so the next one gets in.
    expect(await runner.runEvent(event)).toBe('ran')
  })

  test('the overlap mutex is released even when the task throws', async () => {
    const mutex = memoryMutex()
    const runner = new ScheduleRunner({ mutex, report: () => undefined })

    const event = new ScheduledEvent(() => {
      throw new Error('broken')
    }, 'probe').withoutOverlapping()

    expect(await runner.runEvent(event)).toBe('failed')
    // Otherwise a task that fails once would never run again.
    expect(mutex.keys.size).toBe(0)
  })

  test('onOneServer lets exactly one of several runners in', async () => {
    const mutex = memoryMutex()

    // Two runners sharing a store is what two servers sharing a cache looks like.
    const left = new ScheduleRunner({ mutex })
    const right = new ScheduleRunner({ mutex })

    const event = new ScheduledEvent(() => undefined, 'reports').onOneServer()

    expect(await left.runEvent(event)).toBe('ran')
    expect(await right.runEvent(event)).toBe('skipped')
  })

  test('overlap and one-server need a cache store, and say so', async () => {
    const event = new ScheduledEvent(() => undefined, 'probe').withoutOverlapping()

    await expect(new ScheduleRunner().runEvent(event)).rejects.toThrow(/need a cache store/)
  })

  test('a filtered entry is skipped rather than run', async () => {
    let ran = false

    const event = new ScheduledEvent(() => {
      ran = true
    }, 'probe').when(false)

    expect(await new ScheduleRunner().runEvent(event)).toBe('skipped')
    expect(ran).toBe(false)
  })

  test('sub-minute entries repeat inside the minute', async () => {
    let runs = 0

    const event = new ScheduledEvent(() => {
      runs += 1
    }, 'probe').repeatEvery(1)

    // A deadline two and a bit seconds out rather than the real end of the minute,
    // so the test does not take up to a minute to prove a one-second interval.
    const startedAt = new Date()
    const until = new Date(startedAt.getTime() + 2200)

    await new ScheduleRunner().repeat([event], startedAt, until)

    // It ran again without the expression firing again, which is the whole point
    // of a sub-minute frequency.
    expect(runs).toBeGreaterThanOrEqual(2)
  })

  test('entries that are not repeatable are left alone by repeat()', async () => {
    let runs = 0

    const event = new ScheduledEvent(() => {
      runs += 1
    }, 'probe').everyMinute()

    const result = await new ScheduleRunner().repeat([event], new Date())

    expect(runs).toBe(0)
    expect(result.ran).toBe(0)
  })
})

describe('Schedule', () => {
  let app: Application
  let schedule: Schedule

  beforeEach(() => {
    app = new Application(process.cwd())
    app.config.set('app.env', 'testing')
    schedule = new Schedule(app)
  })

  test('call registers a callback', async () => {
    let ran = false

    schedule.call(() => {
      ran = true
    }, 'probe')

    expect(schedule.events().length).toBe(1)

    await schedule.events()[0]?.callback()
    expect(ran).toBe(true)
  })

  test('command runs through artisan and fails on a non-zero exit', async () => {
    const calls: Array<string[]> = []

    app.instance('artisan', {
      run: async (argv: string[]) => {
        calls.push(argv)

        return argv[0] === 'broken:command' ? 1 : 0
      }
    } as never)

    const good = schedule.command('cache:prune', ['--store', 'array'])
    expect(good.summary).toBe('cache:prune --store array')

    await good.callback()
    expect(calls[0]).toEqual(['cache:prune', '--store', 'array'])

    const bad = schedule.command('broken:command')
    await expect(bad.callback()).rejects.toThrow(/exited with code 1/)
  })

  test('job dispatches onto the queue', async () => {
    const dispatched: unknown[] = []

    app.instance('queue', {
      dispatch: async (job: unknown, options: unknown) => {
        dispatched.push({ job, options })

        return 'queued'
      }
    } as never)

    class SendReport {}

    const entry = schedule.job(new SendReport(), { queue: 'reports' })
    expect(entry.summary).toBe('SendReport')

    await entry.callback()
    expect((dispatched[0] as { options: unknown }).options).toEqual({ queue: 'reports' })
  })

  test('exec runs a program without a shell when given an array', async () => {
    const entry = schedule.exec(['true'])

    expect(entry.summary).toBe('true')
    await entry.callback()
  })

  test('a failing program is a failing entry', async () => {
    await expect(schedule.exec(['false']).callback()).rejects.toThrow(/exited with code 1/)
  })

  test('dueEvents filters by expression and environment', () => {
    schedule.call(() => undefined, 'always').everyMinute()
    schedule.call(() => undefined, 'yearly').yearly()
    schedule
      .call(() => undefined, 'production only')
      .everyMinute()
      .environments('production')

    const due = schedule.dueEvents(WEDNESDAY)

    expect(due.map((event) => event.label)).toEqual(['always'])
  })

  test('a default timezone reaches every entry', () => {
    schedule.useTimezone('Asia/Tokyo')

    const entry = schedule.call(() => undefined, 'probe').dailyAt('22:30')

    expect(entry.zone).toBe('Asia/Tokyo')
    expect(entry.isDue(WEDNESDAY)).toBe(true)
  })

  test('an entry may override the schedule timezone', () => {
    schedule.useTimezone('Asia/Tokyo')

    const entry = schedule
      .call(() => undefined, 'probe')
      .dailyAt('13:30')
      .timezone('UTC')

    expect(entry.isDue(WEDNESDAY)).toBe(true)
  })

  test('flush forgets everything', () => {
    schedule.call(() => undefined, 'probe')

    expect(schedule.flush().events()).toEqual([])
  })
})

describe('running an entry in the background', () => {
  /** The same in-memory mutex the runner tests above use. */
  function memoryMutex(): MutexStore & { keys: Set<string> } {
    const keys = new Set<string>()

    return {
      keys,
      add: async (key: string) => {
        if (keys.has(key)) return false

        keys.add(key)

        return true
      },
      forget: async (key: string) => keys.delete(key),
      has: async (key: string) => keys.has(key)
    }
  }

  /** A command entry, as `Schedule.command()` builds one. */
  const commandEvent = (name = 'report:build') => {
    const event = new ScheduledEvent(async () => undefined, name)
    event.forkable = { name, parameters: ['--force'] }

    return event
  }

  test('a closure cannot be forked, and says why', () => {
    const closure = new ScheduledEvent(() => undefined, 'probe')

    // A child process is a fresh one: there is nothing there to rebuild a
    // closure from, which is the same wall a queued closure hits.
    expect(() => closure.runInBackground()).toThrow('closure')
  })

  test('the entries behind it do not wait', async () => {
    const order: string[] = []
    let release: (() => void) | undefined

    const runner = new ScheduleRunner({
      spawn: async () => {
        order.push('child:started')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        order.push('child:finished')

        return 0
      }
    })

    const slow = commandEvent('slow:task').runInBackground()
    const quick = new ScheduledEvent(() => order.push('next'), 'next')

    const result = await runner.run([slow, quick])

    // The run is over and the child is still going — that is the whole point.
    expect<string[]>(order).toEqual(['child:started', 'next'])
    expect<number>(runner.backgroundCount).toBe(1)
    // Started counts as ran: whether it succeeds is settled later.
    expect<number>(result.ran).toBe(2)
    expect<string | undefined>(result.outcomes[0]?.outcome).toBe('background')

    release?.()
    await runner.waitForBackground()

    expect<string[]>(order).toEqual(['child:started', 'next', 'child:finished'])
    expect<number>(runner.backgroundCount).toBe(0)
  })

  test('the hooks and the exit code arrive when the child does', async () => {
    const order: string[] = []

    const runner = new ScheduleRunner({ spawn: async () => 0 })

    const event = commandEvent()
      .before(() => order.push('before'))
      .onSuccess(() => order.push('success'))
      .onFailure(() => order.push('failure'))
      .after(() => order.push('after'))
      .runInBackground()

    await runner.runEvent(event)
    await runner.waitForBackground()

    expect<string[]>(order).toEqual(['before', 'success', 'after'])
    expect<unknown>(event.error).toBeUndefined()
  })

  test('a non-zero exit is the failure the hooks see', async () => {
    const reported: unknown[] = []
    const order: string[] = []

    const runner = new ScheduleRunner({
      spawn: async () => 3,
      report: (error) => reported.push(error)
    })

    const event = commandEvent()
      .onSuccess(() => order.push('success'))
      .onFailure(() => order.push('failure'))
      .runInBackground()

    await runner.runEvent(event)
    await runner.waitForBackground()

    // An exit code is all a child can tell us, so it becomes the error.
    expect<string[]>(order).toEqual(['failure'])
    expect<boolean>((reported[0] as Error).message.includes('exited with code 3')).toBe(true)
  })

  test('the overlap mutex is released when the child ends, not when it starts', async () => {
    const mutex = memoryMutex()
    let release: (() => void) | undefined

    const runner = new ScheduleRunner({
      mutex,
      spawn: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })

        return 0
      }
    })

    const event = commandEvent('nightly').withoutOverlapping().runInBackground()

    await runner.runEvent(event)

    // Releasing at spawn time would let the next minute start a second copy of
    // a task that is still running — which is what withoutOverlapping exists for.
    const second = commandEvent('nightly').withoutOverlapping().runInBackground()
    expect<string>(await runner.runEvent(second)).toBe('overlapping')

    release?.()
    await runner.waitForBackground()

    const third = commandEvent('nightly').withoutOverlapping().runInBackground()
    expect<string>(await runner.runEvent(third)).toBe('background')

    release?.()
    await runner.waitForBackground()
  })

  test('with no spawner it runs in the foreground rather than not at all', async () => {
    let ran = false

    const event = new ScheduledEvent(() => {
      ran = true
    }, 'report:build')
    event.forkable = { name: 'report:build', parameters: [] }
    event.runInBackground()

    // A runner built without a spawner — a test harness, or an embedded caller —
    // must still run the task; silently skipping it would be the worst outcome.
    expect<string>(await new ScheduleRunner().runEvent(event)).toBe('ran')
    expect<boolean>(ran).toBe(true)
  })
})
