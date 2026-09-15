import { describe, expect, test } from 'bun:test'
import { verbosityOf } from '../src/kernel.ts'
import { Output, ProgressBar } from '../src/output.ts'

/** Captures what a command wrote, so the level rules are testable. */
function captured() {
  const lines: string[] = []
  const output = new Output()

  ;(output as unknown as { line(message?: string, at?: string): void }).line = (
    message = '',
    at = 'normal'
  ) => {
    if (!output.writes(at as never)) return

    lines.push(message)
  }

  return { output, lines }
}

describe('verbosity', () => {
  test('reads the flags', () => {
    expect(verbosityOf([])).toBe('normal')
    expect(verbosityOf(['-v'])).toBe('verbose')
    expect(verbosityOf(['-vv'])).toBe('very-verbose')
    expect(verbosityOf(['-vvv'])).toBe('debug')
    expect(verbosityOf(['--quiet'])).toBe('quiet')
  })

  /** A CI job that asked for silence and got debug output is a log nobody can use. */
  test('quiet wins over verbose when both are given', () => {
    expect(verbosityOf(['-vvv', '--quiet'])).toBe('quiet')
  })

  test('a write below the level is dropped', () => {
    const { output, lines } = captured()

    output.setVerbosity('normal')
    output.line('always')
    output.line('only when asked', 'verbose')

    expect(lines).toEqual(['always'])

    output.setVerbosity('verbose')
    output.line('only when asked', 'verbose')

    expect(lines).toEqual(['always', 'only when asked'])
  })

  test('quiet drops even a normal write', () => {
    const { output, lines } = captured()

    output.setVerbosity('quiet')
    output.line('anything')

    expect(lines).toEqual([])
  })

  test('the predicates', () => {
    const output = new Output()

    output.setVerbosity('very-verbose')

    expect(output.isVerbose()).toBe(true)
    expect(output.isVeryVerbose()).toBe(true)
    expect(output.isDebug()).toBe(false)
    expect(output.isQuiet()).toBe(false)
  })
})

describe('task', () => {
  test('reports what it ran and how long it took', async () => {
    const { output, lines } = captured()

    const answer = await output.task('Migrating', () => 'done')

    expect(answer).toBe('done')
    expect(lines[0]).toContain('Migrating')
    expect(lines[0]).toContain('ms')
  })

  /** The failing step has to be named even when the command dies on it. */
  test('names the step before rethrowing', async () => {
    const { output, lines } = captured()

    await expect(
      output.task('Migrating', () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(lines[0]).toContain('Migrating')
  })
})

describe('bulletList and alert', () => {
  test('a bullet per item', () => {
    const { output, lines } = captured()

    output.bulletList(['one', 'two'])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('one')
  })

  test('the alert is boxed', () => {
    const { output, lines } = captured()

    output.alert('About to touch production')

    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('About to touch production')
  })
})

/**
 * A bar written into a log file is thousands of lines of control codes.
 *
 * `interactive: false` rather than whatever the terminal happens to be: read
 * from `process.stdout.isTTY`, this passed when the suite was piped — CI, and
 * `bun test | cat` — and failed in the terminal somebody actually runs it in,
 * where the bar redraws with `\r` and writes no lines at all. Reported by a
 * developer whose run was the honest one.
 */
describe('the progress bar off a terminal', () => {
  test('writes a line every N items instead of redrawing', () => {
    const { output, lines } = captured()
    const bar = new ProgressBar(output, 4, { every: 2, interactive: false })

    for (let done = 0; done < 4; done += 1) bar.advance()
    bar.finish()

    expect(lines).toEqual(['Progress 2/4', 'Progress 4/4'])
  })

  test('and says nothing at all when quiet', () => {
    const { output, lines } = captured()

    output.setVerbosity('quiet')

    const bar = new ProgressBar(output, 2, { every: 1, interactive: false })

    bar.advance()
    bar.finish()

    expect(lines).toEqual([])
  })

  /** And the other branch, which no test reached while it was read off a global. */
  test('on a terminal it redraws instead, writing no lines', () => {
    const { output, lines } = captured()
    const written: string[] = []
    const was = process.stdout.write

    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk))

      return true
    }) as typeof process.stdout.write

    try {
      const bar = new ProgressBar(output, 4, { every: 2, interactive: true })

      bar.advance()
      bar.finish()
    } finally {
      process.stdout.write = was
    }

    expect(lines).toEqual([])
    expect(written.every((one) => one.startsWith('\r'))).toBe(true)
    expect(written.at(-1)).toContain('1/4')
  })

  test('withProgressBar walks every item', async () => {
    const { output } = captured()
    const seen: number[] = []

    await output.withProgressBar([1, 2, 3], (item) => {
      seen.push(item)
    })

    expect(seen).toEqual([1, 2, 3])
  })
})
