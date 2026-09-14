import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { ModelEvent } from '@elvel/database'
import { Dispatcher } from '@elvel/events'
import type { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { Recorder } from '../src/recorder.ts'
import { CacheWatcher } from '../src/watchers/cache.ts'
import { GateWatcher } from '../src/watchers/gate.ts'
import { ModelWatcher } from '../src/watchers/model.ts'
import { ScheduleWatcher } from '../src/watchers/schedule.ts'
import type { Watcher } from '../src/watchers/watcher.ts'

/**
 * An app with events, a recording recorder, and a watcher registered on it.
 *
 * **Synchronous, and it has to be.** The first version awaited the event
 * provider before calling `enterWorkContext()`, which put the context in the
 * helper's own continuation rather than in the test's frame — so every watcher
 * saw no open batch and nine tests failed while the code was correct.
 * `enterWith` applies to the current execution and what continues from it, and
 * an `await` before it moves which execution that is. `Dispatcher` is
 * constructed directly rather than through its provider for the same reason.
 */
function bench(watcher: Watcher) {
  const app = new Application(process.cwd())
  const recorded: Array<{ type: string; entry: IncomingEntry }> = []
  const lens = new Recorder()

  lens.enable(true)

  app.instance('events', new Dispatcher())
  app.instance('lens', lens)

  enterWorkContext()
  lens.start()

  const original = lens.record.bind(lens)

  lens.record = (type, entry) => {
    original(type, entry)
    recorded.push({ type, entry })
  }

  watcher.register(app)

  return { events: app.make('events'), recorded, lens }
}

function content(entry: IncomingEntry): Record<string, unknown> {
  return entry.content as Record<string, unknown>
}

describe('the cache watcher', () => {
  test('records the four kinds with Telescope words', async () => {
    const { events, recorded } = bench(new CacheWatcher({}))

    await events.dispatch('cache.hit', { key: 'a', value: 1, store: 'file' })
    await events.dispatch('cache.missed', { key: 'b', store: 'file' })
    await events.dispatch('cache.written', { key: 'c', value: 2, seconds: 60, store: 'file' })
    await events.dispatch('cache.forgotten', { key: 'd', store: 'file' })

    expect(recorded.map((one) => content(one.entry).type)).toEqual([
      'hit',
      'missed',
      'set',
      'forget'
    ])
    expect(recorded.every((one) => one.type === EntryType.CACHE)).toBe(true)
    expect(content(recorded[2]?.entry as IncomingEntry).expiration).toBe(60)
  })

  /**
   * The value is recorded, and that is the point of `hidden`.
   *
   * Whatever an application caches lands in a table, so a cached token is a
   * token in the recorder unless its key is named here.
   */
  test('a hidden key keeps the entry and loses the value', async () => {
    const { events, recorded } = bench(new CacheWatcher({ hidden: ['secret*'] }))

    await events.dispatch('cache.hit', { key: 'secret.token', value: 'sekrit' })

    expect(content(recorded[0]?.entry as IncomingEntry).value).toBe('********')
    expect(JSON.stringify(recorded[0]?.entry.content)).not.toContain('sekrit')
  })

  test('an ignored key is not recorded at all', async () => {
    const { events, recorded } = bench(new CacheWatcher({ ignore: ['noisy*'] }))

    await events.dispatch('cache.hit', { key: 'noisy.counter', value: 1 })
    await events.dispatch('cache.hit', { key: 'wanted', value: 1 })

    expect(recorded).toHaveLength(1)
    expect(content(recorded[0]?.entry as IncomingEntry).key).toBe('wanted')
  })

  test('a miss carries no value field at all', async () => {
    const { events, recorded } = bench(new CacheWatcher({}))

    await events.dispatch('cache.missed', { key: 'gone' })

    expect('value' in content(recorded[0]?.entry as IncomingEntry)).toBe(false)
  })
})

describe('the gate watcher', () => {
  /**
   * `ignorePaths` names the framework's own frames, which an installed
   * application gets for free.
   *
   * A gate check reaches the watcher through `@elvel/auth` and then the event
   * dispatcher, so those frames sit between the `can()` call and here. Under
   * `node_modules/@elvel/*` the default list skips them; in this repository they
   * live under `packages/` and have to be named. Without this the recorded file
   * was `packages/events/src/dispatcher.ts` — true, and useless.
   */
  test('records the ability, the answer and where it was asked', async () => {
    const { events, recorded } = bench(
      new GateWatcher({ ignorePaths: ['packages/events/src/', 'packages/auth/src/'] })
    )

    await events.dispatch('gate.evaluated', {
      user: { id: 7 },
      ability: 'update-post',
      result: false,
      arguments: []
    })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.GATE)
    expect(fields.ability).toBe('update-post')
    expect(fields.result).toBe('denied')
    expect(fields.user).toBe(7)
    expect(String(fields.file)).toContain('watchers-more.test.ts')
  })

  /**
   * A gate is handed the model being authorised, and a model carries every
   * column it loaded. Recording that would put application rows in a table for
   * the sake of a boolean.
   */
  test('an argument is named, not serialised', async () => {
    const { events, recorded } = bench(new GateWatcher({}))

    class Post {
      id = 41
      secret = 'do not record me'
    }

    await events.dispatch('gate.evaluated', {
      user: null,
      ability: 'view',
      result: true,
      arguments: [new Post(), 'plain', 3]
    })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(fields.arguments).toEqual(['Post:41', 'plain', 3])
    expect(JSON.stringify(fields)).not.toContain('do not record me')
  })

  test('an ignored ability is skipped', async () => {
    const { events, recorded } = bench(new GateWatcher({ ignoreAbilities: ['view*'] }))

    await events.dispatch('gate.evaluated', { ability: 'view-post', result: true, arguments: [] })
    await events.dispatch('gate.evaluated', { ability: 'delete', result: true, arguments: [] })

    expect(recorded).toHaveLength(1)
    expect(content(recorded[0]?.entry as IncomingEntry).ability).toBe('delete')
  })
})

describe('the model watcher', () => {
  class User {
    id = 3
    private changed: Record<string, unknown> = { name: 'Ada' }

    getChanges(): Record<string, unknown> {
      return this.changed
    }
  }

  test('records the action, the model and what changed', async () => {
    const { events, recorded } = bench(new ModelWatcher({}))

    await events.dispatch('user.updated', new ModelEvent('user.updated', new User() as never))

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.MODEL)
    expect(fields.action).toBe('updated')
    expect(fields.model).toBe('User:3')
    expect(fields.changes).toEqual({ name: 'Ada' })
    expect(recorded[0]?.entry.tags).toContain('User')
  })

  /**
   * Listening per action rather than to `*`, which would catch `cache.hit`,
   * `db.query` and the recorder's own writes.
   */
  test('an unrelated event of the same shape is not a model event', async () => {
    const { events, recorded } = bench(new ModelWatcher({}))

    await events.dispatch('order.created', { id: 1, not: 'a ModelEvent' })

    expect(recorded).toHaveLength(0)
  })

  test('an ignored model class is skipped', async () => {
    const { events, recorded } = bench(new ModelWatcher({ ignore: ['User'] }))

    await events.dispatch('user.created', new ModelEvent('user.created', new User() as never))

    expect(recorded).toHaveLength(0)
  })

  /**
   * An encrypted column holds ciphertext so the value is not readable at rest.
   * Writing the plaintext into an entry hands it to anyone who can open the
   * dashboard, which is the opposite of what the cast was for.
   */
  describe('values a cast kept out of storage', () => {
    class Article {
      static casts: Record<string, string> = { editor_note: 'encrypted', secret: 'hashed' }
      static hidden = ['api_token']

      id = 7
      getChanges(): Record<string, unknown> {
        return {
          title: 'A title',
          editor_note: 'the plaintext',
          secret: 'hunter2',
          api_token: 'tok_live_1',
          internal: 'also private'
        }
      }
    }

    const changesFor = async (watcher: ModelWatcher) => {
      const { events, recorded } = bench(watcher)

      await events.dispatch(
        'article.updated',
        new ModelEvent('article.updated', new Article() as never)
      )

      return content(recorded[0]?.entry as IncomingEntry).changes as Record<string, unknown>
    }

    test('are masked, and the key is kept', async () => {
      const changes = await changesFor(new ModelWatcher({}))

      expect(changes.editor_note).toBe('********')
      expect(changes.secret).toBe('********')
      expect(changes.title).toBe('A title')
    })

    test("so is anything the model's own hidden list names", async () => {
      expect((await changesFor(new ModelWatcher({}))).api_token).toBe('********')
    })

    test('and the watcher takes names of its own', async () => {
      const changes = await changesFor(new ModelWatcher({ hidden: ['internal'] }))

      expect(changes.internal).toBe('********')
      expect(changes.title).toBe('A title')
    })
  })
})

describe('the schedule watcher', () => {
  /**
   * The two outcomes Telescope's approach cannot see.
   *
   * It hangs a `then()` on each event when `schedule:run` starts, so a task that
   * never ran leaves no trace — and "did not run" is a different problem from
   * "ran and failed".
   */
  test('records every outcome, including skipped and overlapping', async () => {
    const { events, recorded } = bench(new ScheduleWatcher({}))

    await events.dispatch('schedule.task.finished', { event: 'prune' })
    await events.dispatch('schedule.task.failed', { event: 'digest', error: new Error('smtp') })
    await events.dispatch('schedule.task.skipped', { event: 'report', reason: 'another server' })
    await events.dispatch('schedule.task.overlapping', { event: 'sync' })

    expect(recorded.map((one) => content(one.entry).outcome)).toEqual([
      'ran',
      'failed',
      'skipped',
      'overlapping'
    ])
    expect(recorded.every((one) => one.type === EntryType.SCHEDULED_TASK)).toBe(true)
    expect(content(recorded[1]?.entry as IncomingEntry).error).toBe('smtp')
    expect(content(recorded[2]?.entry as IncomingEntry).reason).toBe('another server')
  })
})

describe('every new watcher', () => {
  test('records nothing when no batch is open', async () => {
    const app = new Application(process.cwd())
    const lens = new Recorder()
    const recorded: string[] = []

    lens.enable(true)
    app.instance('events', new Dispatcher())
    app.instance('lens', lens)

    lens.record = (type) => {
      recorded.push(type)
    }

    for (const watcher of [
      new CacheWatcher({}),
      new GateWatcher({}),
      new ModelWatcher({}),
      new ScheduleWatcher({})
    ]) {
      watcher.register(app)
    }

    const events = app.make('events')

    // A context, but no batch — nothing called `start()`.
    enterWorkContext()

    await events.dispatch('cache.hit', { key: 'a', value: 1 })
    await events.dispatch('gate.evaluated', { ability: 'x', result: true, arguments: [] })
    await events.dispatch('schedule.task.finished', { event: 'y' })

    expect(recorded).toEqual([])
  })
})
