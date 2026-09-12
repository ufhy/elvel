import { describe, expect, test } from 'bun:test'
import { enterWorkContext } from '@elvel/core'
import { MessageLogged } from '@elvel/log'
import type { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { atLeast } from '../src/log-level.ts'
import { Recorder } from '../src/recorder.ts'
import { ExceptionWatcher } from '../src/watchers/exception.ts'
import { LogWatcher } from '../src/watchers/log.ts'

/** A recorder that keeps what was recorded instead of storing it. */
function spy(): { lens: Recorder; recorded: Array<{ type: string; entry: IncomingEntry }> } {
  const recorded: Array<{ type: string; entry: IncomingEntry }> = []
  const lens = new Recorder()

  lens.enable(true)
  enterWorkContext()
  lens.start()

  const original = lens.record.bind(lens)

  lens.record = (type, entry) => {
    original(type, entry)
    recorded.push({ type, entry })
  }

  return { lens, recorded }
}

/** What `ExceptionHandler.report()` puts in the context, verbatim in shape. */
function reported(message: string, name = 'TypeError'): MessageLogged {
  const error = new Error(message)
  error.name = name

  return new MessageLogged('error', message, { exception: name, stack: error.stack }, 'stack')
}

function drive(watcher: ExceptionWatcher | LogWatcher, lens: Recorder, event: MessageLogged) {
  ;(watcher as unknown as { record(l: Recorder, e: MessageLogged): void }).record(lens, event)
}

describe('the exception watcher', () => {
  test('records the class, message, file and line', () => {
    const { lens, recorded } = spy()

    drive(new ExceptionWatcher({}), lens, reported('it broke'))

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.type).toBe(EntryType.EXCEPTION)

    const content = recorded[0]?.entry.content as Record<string, unknown>

    expect(content.class).toBe('TypeError')
    expect(content.message).toBe('it broke')
    expect(String(content.file)).toContain('watchers.test.ts')
    expect(Number(content.line)).toBeGreaterThan(0)
  })

  /**
   * The message is left out of the hash on purpose.
   *
   * "user 41 not found" and "user 87 not found" are one bug, and a hash over the
   * message would put each of them on the index as news. This is what makes the
   * collapsing already tested in `lens.test.ts` reachable from real failures.
   */
  test('two failures at the same place share a family hash', () => {
    const { lens, recorded } = spy()
    const watcher = new ExceptionWatcher({})

    const event = reported('user 41 not found')

    drive(watcher, lens, event)
    drive(watcher, lens, new MessageLogged('error', 'user 87 not found', event.context, 'stack'))

    expect(recorded[0]?.entry.familyHash()).toBe(recorded[1]?.entry.familyHash())
    expect(recorded[0]?.entry.familyHash()).toBeDefined()
  })

  /**
   * And the other half: a different place is a different bug.
   *
   * The two errors are constructed on two lines here rather than through
   * `reported()`, which is the correction this test needed — routing both
   * through one helper made them share a line, so they shared a hash, and the
   * first version of this test read that as a failure of the code.
   */
  test('failures in different places do not', () => {
    const { lens, recorded } = spy()
    const watcher = new ExceptionWatcher({})

    const here = new Error('one')
    const there = new Error('two')

    drive(
      watcher,
      lens,
      new MessageLogged('error', 'one', { exception: 'Error', stack: here.stack }, 'stack')
    )
    drive(
      watcher,
      lens,
      new MessageLogged('error', 'two', { exception: 'Error', stack: there.stack }, 'stack')
    )

    expect(recorded[0]?.entry.familyHash()).not.toBe(recorded[1]?.entry.familyHash())
  })

  test('carries the source around the failing line', () => {
    const { lens, recorded } = spy()

    drive(new ExceptionWatcher({}), lens, reported('it broke'))

    const content = recorded[0]?.entry.content as Record<string, unknown> | undefined
    const preview = content?.linePreview as Record<string, string>

    expect(Object.keys(preview).length).toBeGreaterThan(0)
    // The first application frame is where the `Error` was constructed.
    expect(Object.values(preview).join('\n')).toContain('const error = new Error(message)')
  })

  test('an ordinary log line is not an exception', () => {
    const { lens, recorded } = spy()

    drive(new ExceptionWatcher({}), lens, new MessageLogged('error', 'just a message', {}, 'stack'))

    expect(recorded).toHaveLength(0)
  })
})

describe('the log watcher', () => {
  test('records at or above the configured level', () => {
    const { lens, recorded } = spy()
    const watcher = new LogWatcher({ level: 'warning' })

    drive(watcher, lens, new MessageLogged('info', 'quiet', {}, 'stack'))
    drive(watcher, lens, new MessageLogged('warning', 'louder', {}, 'stack'))
    drive(watcher, lens, new MessageLogged('emergency', 'loudest', {}, 'stack'))

    expect(recorded.map((one) => (one.entry.content as { message: string }).message)).toEqual([
      'louder',
      'loudest'
    ])
  })

  /**
   * One failure is one row.
   *
   * Both watchers listen to the same event, so without this the exception the
   * handler reported would also be recorded as a log line.
   */
  test('leaves an exception to the exception watcher', () => {
    const { lens, recorded } = spy()

    drive(new LogWatcher({ level: 'debug' }), lens, reported('it broke'))

    expect(recorded).toHaveLength(0)
  })

  test('interpolates scalar context into the message, and only scalars', () => {
    const { lens, recorded } = spy()

    drive(
      new LogWatcher({ level: 'debug' }),
      lens,
      new MessageLogged(
        'info',
        'user {id} did {what} to {obj}',
        {
          id: 41,
          what: 'something',
          obj: { nested: true }
        },
        'stack'
      )
    )

    const content = recorded[0]?.entry.content as { message: string }

    expect(content.message).toBe('user 41 did something to {obj}')
  })

  test('the level defaults to error', () => {
    const { lens, recorded } = spy()
    const watcher = new LogWatcher({})

    drive(watcher, lens, new MessageLogged('warning', 'ignored', {}, 'stack'))
    drive(watcher, lens, new MessageLogged('error', 'kept', {}, 'stack'))

    expect(recorded).toHaveLength(1)
  })
})

describe('atLeast', () => {
  test('orders the eight PSR-3 levels', () => {
    expect(atLeast('emergency', 'debug')).toBe(true)
    expect(atLeast('debug', 'emergency')).toBe(false)
    expect(atLeast('error', 'error')).toBe(true)
    expect(atLeast('warning', 'error')).toBe(false)
  })

  test('an unrecognised level counts as debug', () => {
    expect(atLeast('nonsense', 'debug')).toBe(true)
    expect(atLeast('nonsense', 'error')).toBe(false)
  })
})
