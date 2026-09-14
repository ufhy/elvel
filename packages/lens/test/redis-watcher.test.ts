import { describe, expect, test } from 'bun:test'
import { enterWorkContext } from '@elvel/core'
import type { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { Recorder } from '../src/recorder.ts'
import { RedisWatcher } from '../src/watchers/redis.ts'

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

/** What `@elvel/redis` dispatches, in shape. */
function drive(
  watcher: RedisWatcher,
  lens: Recorder,
  event: Record<string, unknown>,
  failed = false
) {
  ;(
    watcher as unknown as {
      record(l: Recorder, e: Record<string, unknown>, failed: boolean): void
    }
  ).record(lens, event, failed)
}

describe('the Redis watcher', () => {
  test('records the command, its arguments and its timing', () => {
    const { lens, recorded } = spy()

    drive(new RedisWatcher({}), lens, {
      command: 'get',
      args: ['users:1'],
      duration: 0.42,
      connectionName: 'cache'
    })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.type).toBe(EntryType.REDIS)

    const content = recorded[0]?.entry.content as Record<string, unknown>

    expect(content.command).toBe('GET users:1')
    expect(content.connection).toBe('cache')
    expect(content.time).toBe(0.42)
    expect(content.failed).toBe(false)
  })

  test('a failure carries its message instead of a duration', () => {
    const { lens, recorded } = spy()

    drive(
      new RedisWatcher({}),
      lens,
      { command: 'GET', args: ['k'], error: new Error('connection refused') },
      true
    )

    const content = recorded[0]?.entry.content as Record<string, unknown>

    expect(content.failed).toBe(true)
    expect(content.error).toBe('connection refused')
  })

  /** A worker polling every few milliseconds is otherwise the whole timeline. */
  test('ignore drops a command by name', () => {
    const { lens, recorded } = spy()

    drive(new RedisWatcher({ ignore: ['BLPOP'] }), lens, { command: 'blpop', args: ['jobs'] })

    expect(recorded).toHaveLength(0)
  })
})
