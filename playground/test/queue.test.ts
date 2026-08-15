import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'
import { dispatch, type QueueFake, queue } from '@elysian/queue'
import '../bootstrap/app.ts'
import './database.ts'
import { ImportRow } from '../app/Jobs/ImportRow.ts'
import { SendArticleDigest } from '../app/Jobs/SendArticleDigest.ts'

/**
 * The queue, faked.
 *
 * `sync` is not a substitute for this. Running the job inline proves the job
 * works, which is a different question from "did this code dispatch it" — and a
 * job that sends mail or charges a card runs for real. Faked, the push is
 * recorded and nothing happens.
 */
let fake: QueueFake

beforeEach(() => {
  fake = queue().fake()
})

afterEach(() => {
  // A fake left in place makes the next file's dispatches vanish and its tests
  // pass for the wrong reason.
  queue().restore()
})

describe('dispatching', () => {
  it('records the push rather than running the job', async () => {
    await dispatch(new ImportRow({ row: 1 }))

    const pushed = fake.assertPushed('ImportRow')

    // The payload is what a worker would receive, so this is the check that the
    // job carries what it needs — a job dispatched with the wrong id runs
    // perfectly and does the wrong thing.
    expect(pushed.payload.data).toMatchObject({ row: 1 })
  })

  it('nothing dispatched is a thing to assert', () => {
    fake.assertNothingPushed()
    fake.assertNotPushed('ImportRow')
  })

  it('and how many times', async () => {
    await dispatch(new ImportRow({ row: 1 }))
    await dispatch(new ImportRow({ row: 2 }))

    fake.assertPushedTimes('ImportRow', 2).assertCount(2)
  })

  /**
   * The queue a job lands on, which `assertPushed` cannot see.
   *
   * A job pinned to `mail` that ends up on `default` still runs — on whichever
   * worker happens to serve `default`, which on a busy queue means an hour late.
   */
  it('the queue it was pushed to', async () => {
    await dispatch(new SendArticleDigest({ label: 'weekly' }), { queue: 'mail' })

    fake.assertPushedOn('mail', 'SendArticleDigest')

    // And the negative, or the assertion would pass for any queue at all.
    expect(() => fake.assertPushedOn('default', 'SendArticleDigest')).toThrow(/Saw: mail/)
  })

  it('and a delay, which is otherwise invisible', async () => {
    await dispatch(new ImportRow({ row: 1 }), { delay: 60 })

    fake.assertPushedWithDelay('ImportRow', 60)
  })

  /**
   * A job dispatched onto another connection is still caught.
   *
   * Faking has to replace every connection, not only the default one: a job with
   * `static connection = 'redis'` would otherwise reach for Redis in a test that
   * never had it.
   */
  it('whatever connection it names', async () => {
    await dispatch(new ImportRow({ row: 1 }), { connection: 'redis' })

    fake.assertPushed('ImportRow')
  })
})

describe('the failure messages', () => {
  it('name what was actually pushed', async () => {
    await dispatch(new ImportRow({ row: 1 }))

    // A failure that only says "not found" sends somebody to the wrong file.
    expect(() => fake.assertPushed('SendArticleDigest')).toThrow(/Pushed: ImportRow on/)
  })

  it('and a wrong count says both numbers', async () => {
    await dispatch(new ImportRow({ row: 1 }))

    expect(() => fake.assertPushedTimes('ImportRow', 3)).toThrow(/3 time\(s\).*pushed 1/)
  })
})
