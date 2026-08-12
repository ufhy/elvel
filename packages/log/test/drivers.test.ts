import { afterEach, describe, expect, test } from 'bun:test'
import type { LogLevel, LogRecord } from '@elysian/contracts'
import { ConsoleDriver } from '../src/drivers/console.ts'
import { JsonDriver } from '../src/drivers/json.ts'
import { MemoryDriver, NullDriver } from '../src/drivers/misc.ts'

const TIME = new Date('2026-08-11T09:30:00.000Z')

function record(level: LogLevel, message = 'hello', context = {}): LogRecord {
  return { level, message, context, channel: 'probe', time: TIME }
}

const originalLog = console.log
const originalError = console.error

/** Capture stdout and stderr separately: which stream is used is behaviour. */
function capture(body: () => void): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []

  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '))

  try {
    body()
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return { out, err }
}

afterEach(() => {
  console.log = originalLog
  console.error = originalError
})

describe('ConsoleDriver', () => {
  const driver = new ConsoleDriver({ colours: false })

  test('formats time, level, channel and message', () => {
    const { out } = capture(() => driver.write(record('info')))

    expect(out).toHaveLength(1)
    expect(out[0]).toContain('INFO')
    expect(out[0]).toContain('[probe]')
    expect(out[0]).toContain('hello')
  })

  test('appends context only when there is some', () => {
    const withContext = capture(() => driver.write(record('info', 'hi', { id: 7 })))
    const without = capture(() => driver.write(record('info', 'hi')))

    expect(withContext.out[0]).toContain('id')
    expect(without.out[0]?.trimEnd()).toEndWith('hi')
  })

  test('errors and above go to stderr, quieter levels to stdout', () => {
    const quiet = capture(() => {
      driver.write(record('debug'))
      driver.write(record('warning'))
    })
    const loud = capture(() => {
      driver.write(record('error'))
      driver.write(record('emergency'))
    })

    expect(quiet.out).toHaveLength(2)
    expect(quiet.err).toHaveLength(0)
    expect(loud.err).toHaveLength(2)
    expect(loud.out).toHaveLength(0)
  })

  test('the stderr threshold is configurable', () => {
    const noisy = new ConsoleDriver({ colours: false, stderrFrom: 'warning' })
    const { out, err } = capture(() => {
      noisy.write(record('notice'))
      noisy.write(record('warning'))
    })

    expect(out).toHaveLength(1)
    expect(err).toHaveLength(1)
  })

  test('colours off never emits an escape code, whatever the terminal says', () => {
    const plain = new ConsoleDriver({ colours: false })
    const withoutColour = capture(() => plain.write(record('info')))

    /**
     * Asserted on `colours: false` alone, on purpose.
     *
     * What the coloured driver emits is picocolors' business, and picocolors reads
     * the environment — `FORCE_COLOR` makes it paint even when stdout is a pipe. An
     * earlier version of this test compared the two outputs and expected them to
     * match "because a test runner is not a TTY", which quietly asserted something
     * about the machine rather than about this driver, and failed on any shell that
     * exports FORCE_COLOR.
     *
     * Ours to guarantee is the other direction: turning colours off leaves nothing
     * to leak into a log file or a piped stream.
     */
    expect(withoutColour.out[0]).not.toContain(String.fromCharCode(27))
    expect(withoutColour.out[0]).toContain('[probe] hello')
  })
})

describe('JsonDriver', () => {
  test('writes one parseable object per line, context flattened in', () => {
    const { out } = capture(() => new JsonDriver().write(record('warning', 'careful', { id: 7 })))

    expect(JSON.parse(out[0] as string)).toEqual({
      time: '2026-08-11T09:30:00.000Z',
      level: 'warning',
      channel: 'probe',
      message: 'careful',
      id: 7
    })
  })

  test('can target stderr instead', () => {
    const { out, err } = capture(() => new JsonDriver({ stream: 'stderr' }).write(record('error')))

    expect(out).toHaveLength(0)
    expect(err).toHaveLength(1)
  })
})

describe('NullDriver and MemoryDriver', () => {
  test('null writes nowhere', () => {
    const { out, err } = capture(() => new NullDriver().write())

    expect(out).toHaveLength(0)
    expect(err).toHaveLength(0)
  })

  test('memory keeps records until cleared', () => {
    const driver = new MemoryDriver()

    driver.write(record('info'))
    expect(driver.records).toHaveLength(1)

    driver.clear()
    expect(driver.records).toHaveLength(0)
  })
})
