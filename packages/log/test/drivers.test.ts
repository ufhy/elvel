import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogLevel, LogRecord } from '@elvel/contracts'
import { stripControl } from '../src/console/log-tail.ts'
import { ConsoleDriver } from '../src/drivers/console.ts'
import { RotatingDriver } from '../src/drivers/file.ts'
import { JsonDriver } from '../src/drivers/json.ts'
import { ErrorLogDriver, MemoryDriver, NullDriver, SlackDriver } from '../src/drivers/misc.ts'
import { SyslogDriver } from '../src/drivers/syslog.ts'

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

describe('the errorlog and slack drivers', () => {
  test('errorlog writes one plain line per record to stderr', () => {
    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)

    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))

      return true
    }) as typeof process.stderr.write

    try {
      new ErrorLogDriver().write({
        level: 'error',
        message: 'it broke',
        context: { id: 7 },
        channel: 'app',
        time: new Date('2026-08-13T00:00:00.000Z')
      })
    } finally {
      process.stderr.write = original
    }

    // One line, parseable: stderr is what a container runtime collects, and a
    // collector reads lines rather than colours.
    expect<number>(written.length).toBe(1)
    expect<boolean>(
      written[0]?.startsWith('[2026-08-13T00:00:00.000Z] app.ERROR: it broke') === true
    ).toBe(true)
    expect<boolean>(written[0]?.includes('{"id":7}') === true).toBe(true)
  })

  test('slack posts, and only at or above its level', async () => {
    const posts: Array<{ text: string }> = []

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        posts.push((await request.json()) as { text: string })

        return new Response('ok')
      }
    })

    try {
      const driver = new SlackDriver({ url: `http://127.0.0.1:${server.port}`, level: 'error' })

      driver.write({
        level: 'info',
        message: 'ignored',
        context: {},
        channel: 'app',
        time: new Date()
      })
      driver.write({
        level: 'error',
        message: 'noticed',
        context: {},
        channel: 'app',
        time: new Date()
      })
      driver.write({
        level: 'critical',
        message: 'worse',
        context: {},
        channel: 'app',
        time: new Date()
      })

      // Fire-and-forget: a logging call must not wait on Slack.
      await Bun.sleep(120)

      // A channel that receives every info is a channel everybody mutes.
      expect<number>(posts.length).toBe(2)

      /**
       * By content, not by position.
       *
       * The writes are fire-and-forget, so the two posts that survive the level
       * filter race each other to the server and arrive in either order. Reading
       * `posts[0]` passed on three machines and failed on the fourth.
       */
      const texts = posts.map((post) => post.text)

      expect<boolean>(texts.some((text) => text.includes('*ERROR* [app] noticed'))).toBe(true)
      expect<boolean>(texts.some((text) => text.includes('*CRITICAL* [app] worse'))).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('a delivery failure is reported, not thrown', async () => {
    const reported: unknown[] = []

    // Nothing is listening on this port; the fetch rejects.
    new SlackDriver({ url: 'http://127.0.0.1:1/', level: 'debug' }, (error) =>
      reported.push(error)
    ).write({ level: 'error', message: 'x', context: {}, channel: 'app', time: new Date() })

    await Bun.sleep(120)

    // An unhandled rejection here would take the process down with it.
    expect<number>(reported.length).toBe(1)
  })
})

describe('what reaches the terminal', () => {
  const esc = String.fromCharCode(27)

  test('an escape sequence in a log line is stripped', () => {
    const hostile = `[2026-08-13T00:00:00.000Z] app.ERROR: user said ${esc}[2J${esc}[Hgotcha`

    // A log line carries whatever was logged, and that routinely includes user
    // input. An escape sequence in there is executed by the terminal showing it.
    expect<boolean>(stripControl(hostile).includes(esc)).toBe(false)
    expect<boolean>(stripControl(hostile).endsWith('user said gotcha')).toBe(true)
  })

  test('tabs survive, because a logged payload has them', () => {
    expect<string>(stripControl('a\tb')).toBe('a\tb')
  })

  test('other control characters are shown, not dropped', () => {
    // Dropping them would let a line look shorter than what was written.
    expect<string>(stripControl(`a${String.fromCharCode(0)}b`)).toBe('a�b')
    expect<string>(stripControl(`a${String.fromCharCode(127)}b`)).toBe('a�b')
  })
})

describe('rotating', () => {
  /** A busy application gets one file per day whatever its size, without this. */
  test('starts a new file when the current one fills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvel-rotating-'))
    const driver = new RotatingDriver(join(directory, 'elvel.log'), {
      maxBytes: 120,
      now: () => new Date('2026-08-11T09:00:00.000Z')
    })

    for (let line = 0; line < 4; line += 1) {
      await driver.write(record('info', `line ${line}`))
    }

    const files = (await readdir(directory)).sort()

    expect(files.length).toBeGreaterThan(1)
    expect(files[0]).toBe('elvel-2026-08-11.000.log')
    expect(files[1]).toBe('elvel-2026-08-11.001.log')

    await rm(directory, { recursive: true, force: true })
  })

  /** Or a prune that trusts the sort deletes the newest file. */
  test('and the names still sort oldest first', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvel-rotating-'))
    const driver = new RotatingDriver(join(directory, 'elvel.log'), {
      maxBytes: 120,
      maxFiles: 2,
      now: () => new Date('2026-08-11T09:00:00.000Z')
    })

    for (let line = 0; line < 6; line += 1) await driver.write(record('info', `line ${line}`))

    const files = await readdir(directory)

    expect([...files].sort()).toEqual(files.sort())

    await rm(directory, { recursive: true, force: true })
  })

  test('a period other than daily', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elvel-rotating-'))

    const written = async (period: 'hourly' | 'weekly' | 'monthly' | 'never') => {
      const driver = new RotatingDriver(join(directory, `${period}.log`), {
        period,
        now: () => new Date('2026-08-11T09:30:00.000Z')
      })

      await driver.write(record('info', 'one'))
    }

    await written('hourly')
    await written('weekly')
    await written('monthly')
    await written('never')

    const files = await readdir(directory)

    expect(files).toContain('hourly-2026-08-11-09.log')
    expect(files).toContain('weekly-2026-W33.log')
    expect(files).toContain('monthly-2026-08.log')
    expect(files).toContain('never.log')

    await rm(directory, { recursive: true, force: true })
  })
})

describe('syslog', () => {
  /** RFC 5424: the priority is facility * 8 + severity, and the severities are its own. */
  test('formats a line the collector can parse', async () => {
    const sent: string[] = []
    const driver = new SyslogDriver({ facility: 16, appName: 'shop' })

    // The socket is the only thing worth faking here; the format is the point.
    ;(driver as unknown as { open(): { send(...args: unknown[]): void } }).open = () => ({
      send: (line: unknown) => sent.push(String(line))
    })

    await driver.write(record('warning', 'disk almost full'))

    expect(sent[0]).toStartWith('<132>1 ')
    expect(sent[0]).toContain(' shop ')
    expect(sent[0]).toContain('disk almost full')
  })

  test('a delivery failure is reported, not thrown', async () => {
    const failures: unknown[] = []
    const driver = new SyslogDriver({ onError: (error) => failures.push(error) })

    ;(driver as unknown as { open(): unknown }).open = () => {
      throw new Error('no socket')
    }

    await driver.write(record('info', 'anything'))

    expect(failures).toHaveLength(1)
  })
})
