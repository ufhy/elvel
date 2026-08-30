import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Output } from '../src/output.ts'

/**
 * A prompt with nobody there to answer it.
 *
 * Every prompt used to **hang** where no terminal is attached, which is every CI
 * job and every cron entry: `migrate` in production asks for confirmation, and
 * from a pipeline it rendered the question and waited for ever. A deploy that
 * holds its lock and never fails is worse than one that fails — nothing reports
 * it, and nobody is told to pass `--force`.
 */
describe('without a terminal', () => {
  const tty = process.stdin.isTTY

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
  })

  test('confirm takes the default rather than waiting', async () => {
    const output = new Output()

    // `false` is `confirmInProduction`'s default, so this is the safe direction:
    // a non-interactive production run refuses instead of proceeding.
    expect(await output.confirm('Really?', false)).toBe(false)
    expect(await output.confirm('Really?', true)).toBe(true)
  })

  test('ask and choice take theirs too', async () => {
    const output = new Output()

    expect(await output.ask('Name?', 'ada')).toBe('ada')
    expect(await output.ask('Name?')).toBe('')
    expect(await output.choice('Which?', ['a', 'b'], 'b')).toBe('b')
    expect(await output.choice('Which?', ['a', 'b'])).toBe('a')
  })

  test('secret refuses instead, since a blank password is not an answer', async () => {
    const output = new Output()

    await expect(output.secret('Token?')).rejects.toThrow(/needs a terminal/)
  })
})
