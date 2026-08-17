import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { DailyDriver, FileDriver } from '../src/drivers/file.ts'
import { MemoryDriver } from '../src/drivers/misc.ts'
import { LogManager } from '../src/manager.ts'

let app: Application
let manager: LogManager
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-log-'))
  app = new Application(root)
  app.config.set('logging', {
    default: 'memory',
    channels: {
      memory: { driver: 'memory' },
      quiet: { driver: 'memory', level: 'error' },
      discard: { driver: 'null' },
      everything: { driver: 'stack', channels: ['memory', 'discard'] }
    }
  })
  manager = new LogManager(app)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolution', () => {
  test('the default channel comes from config', () => {
    expect(manager.getDefaultDriver()).toBe('memory')
    expect(manager.channel().channel).toBe('memory')
  })

  test('setDefaultDriver changes what channel() returns', () => {
    manager.setDefaultDriver('discard')

    expect(manager.channel().channel).toBe('discard')
  })

  test('channels are cached, so context sticks', () => {
    expect(manager.channel('memory')).toBe(manager.channel('memory'))
  })

  test('forgetChannel drops the cached instance', () => {
    const first = manager.channel('memory')
    manager.forgetChannel('memory')

    expect(manager.channel('memory')).not.toBe(first)
  })

  test('an undefined channel names itself in the error', () => {
    expect(() => manager.channel('nope')).toThrow(/Log channel \[nope\] is not defined/)
  })

  test('an unsupported driver points at extend()', () => {
    app.config.set('logging.channels.weird', { driver: 'smoke-signals' })

    expect(() => manager.channel('weird')).toThrow(/not supported.*extend/s)
  })

  test('an invalid level fails at resolution, not at write time', () => {
    app.config.set('logging.channels.broken', { driver: 'memory', level: 'verbose' })

    expect(() => manager.channel('broken')).toThrow(/Invalid log level/)
  })

  test('a stack that includes itself is rejected instead of recursing', () => {
    app.config.set('logging.channels.loop', { driver: 'stack', channels: ['loop'] })

    expect(() => manager.channel('loop')).toThrow(/cannot include itself/)
  })
})

describe('extend', () => {
  test('a custom driver replaces the built-in resolution', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)
    app.config.set('logging.channels.custom', { driver: 'probe' })

    manager.channel('custom').info('through the custom driver')

    expect(driver.records).toHaveLength(1)
    expect(driver.records[0]?.channel).toBe('custom')
  })

  test('the factory receives the channel config and name', () => {
    let seen: unknown
    manager.extend('probe', (config, name) => {
      seen = { config, name }
      return new MemoryDriver()
    })
    app.config.set('logging.channels.custom', { driver: 'probe', level: 'warning' })

    manager.channel('custom')

    expect(seen).toMatchObject({ name: 'custom', config: { driver: 'probe', level: 'warning' } })
  })
})

describe('build and stack', () => {
  test('build creates an on-demand channel without config', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)

    manager.build({ driver: 'probe', level: 'info' }, 'ondemand').info('built')

    expect(driver.records[0]?.channel).toBe('ondemand')
  })

  test('build channels are not cached', () => {
    manager.extend('probe', () => new MemoryDriver())

    expect(manager.build({ driver: 'probe' })).not.toBe(manager.build({ driver: 'probe' }))
  })

  test('an on-demand stack writes to every named channel', async () => {
    const first = new MemoryDriver()
    const second = new MemoryDriver()
    manager.extend('one', () => first)
    manager.extend('two', () => second)
    app.config.set('logging.channels.one', { driver: 'one' })
    app.config.set('logging.channels.two', { driver: 'two' })

    manager.stack(['one', 'two']).error('to both')

    // A stack awaits between drivers, and logging is fire-and-forget, so only
    // the first driver has run by the time this line executes.
    expect(first.records).toHaveLength(1)
    expect(second.records).toHaveLength(0)

    await Promise.resolve()
    expect(second.records).toHaveLength(1)
  })
})

describe('shared context', () => {
  test('applies to channels resolved later', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)
    app.config.set('logging.channels.custom', { driver: 'probe' })

    manager.shareContext({ request_id: 'abc' })
    manager.channel('custom').info('after sharing')

    expect(driver.records[0]?.context).toEqual({ request_id: 'abc' })
  })

  test('applies to channels already resolved', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)
    app.config.set('logging.channels.custom', { driver: 'probe' })

    const channel = manager.channel('custom')
    manager.shareContext({ tenant: 9 })
    channel.info('after sharing')

    expect(driver.records[0]?.context).toEqual({ tenant: 9 })
  })

  test('flushSharedContext clears it everywhere', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)
    app.config.set('logging.channels.custom', { driver: 'probe' })

    const channel = manager.channel('custom')
    manager.shareContext({ tenant: 9 })
    manager.flushSharedContext()
    channel.info('after flushing')

    expect(manager.sharedContext()).toEqual({})
    expect(driver.records[0]?.context).toEqual({})
  })
})

describe('proxying', () => {
  test('the manager logs to the default channel', () => {
    const driver = new MemoryDriver()
    manager.extend('probe', () => driver)
    app.config.set('logging.channels.memory', { driver: 'probe' })

    manager.info('via the manager')
    manager.log('alert', 'also via the manager')

    expect(driver.records.map((record) => record.level)).toEqual(['info', 'alert'])
  })
})

describe('file drivers', () => {
  test('single appends lines to one file', async () => {
    const path = join(root, 'logs', 'app.log')
    const driver = new FileDriver(path)

    await driver.write({
      level: 'info',
      message: 'first',
      context: {},
      channel: 'single',
      time: new Date('2026-08-11T00:00:00Z')
    })
    await driver.write({
      level: 'error',
      message: 'second',
      context: { code: 1 },
      channel: 'single',
      time: new Date('2026-08-11T00:00:01Z')
    })

    const contents = await Bun.file(path).text()
    const lines = contents.trim().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('single.INFO: first')
    expect(lines[1]).toContain('single.ERROR: second {"code":1}')
  })

  test('concurrent writes do not interleave', async () => {
    const path = join(root, 'logs', 'concurrent.log')
    const driver = new FileDriver(path)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        driver.write({
          level: 'info',
          message: `line-${index}`,
          context: {},
          channel: 'single',
          time: new Date()
        })
      )
    )

    const lines = (await Bun.file(path).text()).trim().split('\n')

    expect(lines).toHaveLength(20)
    expect(lines.every((line) => line.includes('line-'))).toBe(true)
  })

  test('daily writes to a dated file', async () => {
    const path = join(root, 'logs', 'app.log')
    const driver = new DailyDriver(path, { now: () => new Date('2026-08-11T12:00:00Z') })

    await driver.write({
      level: 'info',
      message: 'dated',
      context: {},
      channel: 'daily',
      time: new Date('2026-08-11T12:00:00Z')
    })

    expect(await Bun.file(join(root, 'logs', 'app-2026-08-11.log')).exists()).toBe(true)
  })

  test('daily prunes files beyond maxFiles', async () => {
    const directory = join(root, 'logs')

    for (const day of ['08', '09', '10']) {
      await Bun.write(join(directory, `app-2026-08-${day}.log`), 'old\n')
    }

    const driver = new DailyDriver(join(directory, 'app.log'), {
      maxFiles: 2,
      now: () => new Date('2026-08-11T00:00:00Z')
    })

    await driver.write({
      level: 'info',
      message: 'today',
      context: {},
      channel: 'daily',
      time: new Date('2026-08-11T00:00:00Z')
    })

    const remaining = (await readdir(directory)).sort()

    expect(remaining).toEqual(['app-2026-08-10.log', 'app-2026-08-11.log'])
  })

  test('maxFiles: 0 keeps everything', async () => {
    const directory = join(root, 'logs')
    await Bun.write(join(directory, 'app-2026-01-01.log'), 'old\n')

    const driver = new DailyDriver(join(directory, 'app.log'), {
      maxFiles: 0,
      now: () => new Date('2026-08-11T00:00:00Z')
    })

    await driver.write({
      level: 'info',
      message: 'today',
      context: {},
      channel: 'daily',
      time: new Date('2026-08-11T00:00:00Z')
    })

    expect((await readdir(directory)).sort()).toEqual(['app-2026-01-01.log', 'app-2026-08-11.log'])
  })
})
describe('the deprecation channel', () => {
  test('it is silent until one is configured', () => {
    const app = new Application(process.cwd())
    app.config.set('logging.channels', { null: { driver: 'null' } })

    // An application that never configures one should not suddenly be noisy.
    expect(() => new LogManager(app).deprecate('old thing')).not.toThrow()
  })

  test('and goes to its own channel when it is', () => {
    const app = new Application(process.cwd())
    app.config.set('logging.deprecations', 'notices')
    app.config.set('logging.channels', {
      notices: { driver: 'memory' },
      stderr: { driver: 'memory' }
    })

    const manager = new LogManager(app)
    manager.deprecate('Model::oldMethod is going away', { since: '2.0' })

    const driver = manager.channel('notices').driver as MemoryDriver

    // Its own channel, not the application's: a real error must not be lost
    // among forty notices about a method rename.
    expect<number>(driver.records.length).toBe(1)
    expect<string>(driver.records[0]?.level ?? '').toBe('warning')
    expect<number>((manager.channel('stderr').driver as MemoryDriver).records.length).toBe(0)
  })
})
