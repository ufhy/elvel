import { describe, expect, test } from 'bun:test'
import { MemoryDriver, StackDriver } from '../src/drivers/misc.ts'
import { InvalidLogLevelError, isHandling, LEVEL_NAMES, severityOf } from '../src/levels.ts'
import { interpolate, Logger } from '../src/logger.ts'

const FIXED = new Date('2026-08-11T09:30:00.000Z')

function makeLogger(options: { level?: Parameters<typeof severityOf>[0] } = {}) {
  const driver = new MemoryDriver()
  const logger = new Logger({
    channel: 'probe',
    driver,
    level: (options.level as never) ?? 'debug',
    now: () => FIXED
  })

  return { driver, logger }
}

describe('levels', () => {
  test('exposes the eight RFC 5424 levels in descending severity', () => {
    expect(LEVEL_NAMES).toEqual([
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'notice',
      'info',
      'debug'
    ])
  })

  test('severity ordering matches Monolog', () => {
    expect(severityOf('emergency')).toBeGreaterThan(severityOf('error'))
    expect(severityOf('error')).toBeGreaterThan(severityOf('warning'))
    expect(severityOf('info')).toBeGreaterThan(severityOf('debug'))
  })

  test('an unknown level is rejected, not silently defaulted', () => {
    expect(() => severityOf('verbose')).toThrow(InvalidLogLevelError)
    expect(() => severityOf('verbose')).toThrow(/Expected one of/)
  })

  test('isHandling compares against the minimum', () => {
    expect(isHandling('error', 'info')).toBe(true)
    expect(isHandling('info', 'info')).toBe(true)
    expect(isHandling('debug', 'info')).toBe(false)
  })
})

describe('interpolate', () => {
  test('replaces placeholders from context', () => {
    expect(interpolate('User {id} signed in', { id: 7 })).toBe('User 7 signed in')
  })

  test('leaves unknown placeholders alone', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}')
  })

  test('serialises objects', () => {
    expect(interpolate('Payload {data}', { data: { a: 1 } })).toBe('Payload {"a":1}')
  })

  test('short-circuits when there is nothing to replace', () => {
    expect(interpolate('plain message', { id: 1 })).toBe('plain message')
  })
})

describe('Logger', () => {
  test('writes a record carrying level, channel and time', () => {
    const { driver, logger } = makeLogger()

    logger.info('hello')

    expect(driver.records).toHaveLength(1)
    expect(driver.records[0]).toMatchObject({
      level: 'info',
      message: 'hello',
      channel: 'probe',
      time: FIXED
    })
  })

  test('exposes every level as a method', () => {
    const { driver, logger } = makeLogger()

    for (const level of LEVEL_NAMES) {
      logger[level](`${level} message`)
    }

    expect(driver.records.map((record) => record.level)).toEqual(LEVEL_NAMES)
  })

  test('drops records below the channel level', () => {
    const { driver, logger } = makeLogger({ level: 'warning' })

    logger.debug('dropped')
    logger.info('dropped')
    logger.warning('kept')
    logger.error('kept')

    expect(driver.records.map((record) => record.level)).toEqual(['warning', 'error'])
  })

  test('interpolates the message and keeps the context', () => {
    const { driver, logger } = makeLogger()

    logger.info('User {id} signed in', { id: 7 })

    expect(driver.records[0]?.message).toBe('User 7 signed in')
    expect(driver.records[0]?.context).toEqual({ id: 7 })
  })

  test('withContext sticks to later records and is overridable per call', () => {
    const { driver, logger } = makeLogger()

    logger.withContext({ request_id: 'abc', tenant: 1 })
    logger.info('first')
    logger.info('second', { tenant: 2 })

    expect(driver.records[0]?.context).toEqual({ request_id: 'abc', tenant: 1 })
    expect(driver.records[1]?.context).toEqual({ request_id: 'abc', tenant: 2 })
  })

  test('withoutContext clears selected keys, or all of them', () => {
    const { driver, logger } = makeLogger()

    logger.withContext({ a: 1, b: 2 })
    logger.withoutContext(['a'])
    logger.info('partial')

    logger.withoutContext()
    logger.info('empty')

    expect(driver.records[0]?.context).toEqual({ b: 2 })
    expect(driver.records[1]?.context).toEqual({})
  })

  test('a filtered call never reaches the driver at all', () => {
    const { driver, logger } = makeLogger({ level: 'error' })

    logger.debug('never formatted')

    expect(driver.records).toHaveLength(0)
  })

  test('log() takes the level as an argument', () => {
    const { driver, logger } = makeLogger()

    logger.log('notice', 'via log()')

    expect(driver.records[0]?.level).toBe('notice')
  })

  test('dispatches MessageLogged when a dispatcher is present', async () => {
    const driver = new MemoryDriver()
    const seen: unknown[] = []

    const logger = new Logger({
      channel: 'probe',
      driver,
      dispatcher: {
        dispatch: async (event: unknown) => {
          seen.push(event)
          return []
        }
      } as never
    })

    logger.warning('watch out', { code: 1 })
    await Promise.resolve()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      level: 'warning',
      message: 'watch out',
      channel: 'probe'
    })
  })
})

describe('StackDriver', () => {
  test('a member keeps its own level', async () => {
    const quiet = new MemoryDriver()
    const loud = new MemoryDriver()

    /**
     * A level is enforced by the `Logger`, not by the driver beneath it, so a
     * stack handed bare drivers applied only its own threshold and every member's
     * was discarded. `stack` is the default channel in a scaffolded application,
     * which made that the ordinary path: a `json` channel configured at
     * `warning` still wrote the `info` lines the stack was reached with.
     */
    const stack = new StackDriver([{ level: 'warning', driver: quiet }, { driver: loud }])

    await stack.write({ level: 'info', message: 'low', context: {}, channel: 'stack', time: FIXED })
    await stack.write({
      level: 'error',
      message: 'high',
      context: {},
      channel: 'stack',
      time: FIXED
    })

    expect(quiet.records.map((one) => one.message)).toEqual(['high'])
    expect(loud.records.map((one) => one.message)).toEqual(['low', 'high'])
  })

  test('fans one record out to every driver', async () => {
    const first = new MemoryDriver()
    const second = new MemoryDriver()

    await new StackDriver([{ driver: first }, { driver: second }]).write({
      level: 'info',
      message: 'fanned',
      context: {},
      channel: 'stack',
      time: FIXED
    })

    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(1)
  })
})
