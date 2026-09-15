import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrayStore, Repository } from '@elvel/cache'
import type { JobPayload, QueueDriver, QueuedJob } from '../src/contracts.ts'
import { FailoverQueue } from '../src/drivers/failover.ts'
import { NullQueue } from '../src/drivers/null.ts'
import { FileFailedJobStore, NullFailedJobStore } from '../src/failed.ts'
import type { AnyJob } from '../src/job.ts'
import { FailOnException, Release, ThrottlesExceptions } from '../src/middleware.ts'

const payload = (uuid: string = crypto.randomUUID()): JobPayload => ({
  uuid: uuid as JobPayload['uuid'],
  job: 'SendInvoice',
  displayName: 'SendInvoice',
  data: {},
  attempts: 0,
  createdAt: 0
})

/** Enough of a job for a middleware: what it was told to do, and nothing else. */
function job() {
  const did: Array<[string, unknown]> = []

  return {
    did,
    handle: {
      payload: payload(),
      releaseJob: async (delay: number) => did.push(['release', delay]),
      deleteJob: async () => did.push(['delete', undefined]),
      failJob: async (error: unknown) => did.push(['fail', error])
    } as unknown as AnyJob
  }
}

const cache = () => new Repository(new ArrayStore())

describe('the circuit breaker', () => {
  /** Until it trips, a failure is still a failure. */
  test('a failure below the threshold is rethrown', async () => {
    const guard = new ThrottlesExceptions(cache(), 'stripe', 3)
    const { handle, did } = job()

    await expect(
      guard.handle(handle, async () => {
        throw new Error('upstream 503')
      })
    ).rejects.toThrow('upstream 503')

    expect(did).toEqual([])
  })

  /** The whole point: the backlog is released, not sent at a service that is down. */
  test('once it trips, further jobs are released rather than attempted', async () => {
    const shared = cache()
    const guard = () => new ThrottlesExceptions(shared, 'stripe', 2, { retryAfterSeconds: 30 })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { handle } = job()

      await guard()
        .handle(handle, async () => {
          throw new Error('upstream 503')
        })
        .catch(() => undefined)
    }

    const { handle, did } = job()
    let ran = false

    await guard().handle(handle, async () => {
      ran = true
    })

    expect(ran).toBe(false)
    expect(did).toEqual([['release', 30]])
  })

  /** A per-process breaker would open N times and let N jobs through per failure. */
  test('the circuit is shared, so a second worker sees it open', async () => {
    const shared = cache()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await new ThrottlesExceptions(shared, 'stripe', 2)
        .handle(job().handle, async () => {
          throw new Error('down')
        })
        .catch(() => undefined)
    }

    expect(await new ThrottlesExceptions(shared, 'stripe', 2).isOpen()).toBe(true)
  })

  test('a success leaves it closed', async () => {
    const guard = new ThrottlesExceptions(cache(), 'stripe', 1)

    await guard.handle(job().handle, async () => undefined)

    expect(await guard.isOpen()).toBe(false)
  })

  test('when() decides which failures count', async () => {
    const shared = cache()
    const guard = () =>
      new ThrottlesExceptions(shared, 'stripe', 1, {
        when: (error) => (error as Error).message.includes('503')
      })

    await guard()
      .handle(job().handle, async () => {
        throw new Error('422 bad request')
      })
      .catch(() => undefined)

    expect(await guard().isOpen()).toBe(false)
  })

  test('and reset closes it by hand, for a deploy that fixed it', async () => {
    const shared = cache()
    const guard = new ThrottlesExceptions(shared, 'stripe', 1)

    await guard
      .handle(job().handle, async () => {
        throw new Error('down')
      })
      .catch(() => undefined)

    expect(await guard.isOpen()).toBe(true)

    await guard.reset()

    expect(await guard.isOpen()).toBe(false)
  })
})

describe('FailOnException', () => {
  class Malformed extends Error {}

  /** The second attempt fails the same way as the first. */
  test('fails outright for an error a retry cannot fix', async () => {
    const { handle, did } = job()

    await new FailOnException([Malformed]).handle(handle, async () => {
      throw new Malformed('bad payload')
    })

    expect(did[0]?.[0]).toBe('fail')
  })

  test('and rethrows anything else, so the retry still happens', async () => {
    const { handle, did } = job()

    await expect(
      new FailOnException([Malformed]).handle(handle, async () => {
        throw new Error('timeout')
      })
    ).rejects.toThrow('timeout')

    expect(did).toEqual([])
  })
})

/** Skip deletes and Release puts back — whether the work still needs doing. */
describe('Release', () => {
  test('puts the job back instead of running it', async () => {
    const { handle, did } = job()
    let ran = false

    await new Release(() => true, 45).handle(handle, async () => {
      ran = true
    })

    expect(ran).toBe(false)
    expect(did).toEqual([['release', 45]])
  })
})

describe('the null queue', () => {
  test('discards, and says the queue is empty', async () => {
    const queue = new NullQueue('null')

    expect(await queue.push(payload('abc'))).toBe('abc')
    expect(await queue.pop()).toBeNull()
    expect(await queue.size()).toBe(0)
  })
})

describe('failover', () => {
  const driver = (name: string, fails: boolean): QueueDriver => ({
    connectionName: name,
    defaultQueue: 'default',
    push: async (given) => {
      if (fails) throw new Error(`${name} is down`)

      return given.uuid
    },
    later: async (_delay, given) => {
      if (fails) throw new Error(`${name} is down`)

      return given.uuid
    },
    pop: async (): Promise<QueuedJob | null> => null,
    size: async () => (fails ? Promise.reject(new Error('down')) : 1),
    clear: async () => 0
  })

  test('a push falls through to the next connection', async () => {
    const queue = new FailoverQueue('failover', [driver('redis', true), driver('database', false)])

    expect(await queue.push(payload('abc'))).toBe('abc')
  })

  /** The first error is "Redis is down" — the useful one is why the fallback failed. */
  test('and the last error surfaces when none of them took it', async () => {
    const queue = new FailoverQueue('failover', [driver('redis', true), driver('database', true)])

    await expect(queue.push(payload())).rejects.toThrow('database is down')
  })

  /** A worker that fell through would drain one queue and leave the other unread. */
  test('reads come from the first connection only', async () => {
    let asked = 0

    const counting: QueueDriver = {
      ...driver('redis', false),
      pop: async () => {
        asked += 1

        return null
      }
    }

    await new FailoverQueue('failover', [counting, driver('database', false)]).pop()

    expect(asked).toBe(1)
  })

  test('size adds up what it can reach', async () => {
    const queue = new FailoverQueue('failover', [driver('redis', true), driver('database', false)])

    expect(await queue.size()).toBe(1)
  })

  test('and a failover with nothing to try is refused at construction', () => {
    expect(() => new FailoverQueue('failover', [])).toThrow('nothing to fail over to')
  })
})

describe('the file failed-job store', () => {
  test('records a failure and reads it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-failed-'))
    const store = new FileFailedJobStore(join(root, 'deep', 'failed.jsonl'))

    const id = await store.log('redis', 'default', payload('one'), new Error('boom'))

    const records = await store.all()

    expect(records).toHaveLength(1)
    expect(records[0]?.uuid).toBe('one')
    expect(records[0]?.exception).toContain('boom')
    expect((await store.find(id))?.uuid).toBe('one')

    await rm(root, { recursive: true, force: true })
  })

  test('forget and flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-failed-'))
    const store = new FileFailedJobStore(join(root, 'failed.jsonl'))

    const first = await store.log('redis', 'default', payload('one'), new Error('a'))
    await store.log('redis', 'default', payload('two'), new Error('b'))

    expect(await store.forget(first)).toBe(true)
    expect(await store.all()).toHaveLength(1)
    expect(await store.flush()).toBe(1)
    expect(await store.all()).toEqual([])

    await rm(root, { recursive: true, force: true })
  })

  /**
   * A job's data is whatever the request carried, and it is written to a file.
   *
   * That is the feature — a failure is only retryable if its payload was kept —
   * but it means untrusted text reaches a format where one record is one line.
   * `JSON.stringify` escapes the newline, so a payload cannot forge a second
   * record; asserted here rather than assumed, because the day somebody
   * replaces the serialiser is the day it stops being true.
   */
  test('a payload cannot forge a second record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-failed-'))
    const path = join(root, 'failed.jsonl')
    const store = new FileFailedJobStore(path)

    const forged = {
      ...payload('honest'),
      data: {
        note: `x\n${JSON.stringify({ id: 'forged', uuid: 'forged', connection: 'redis' })}\n`
      }
    }

    await store.log('redis', 'default', forged, new Error('boom'))

    const records = await store.all()

    expect(records).toHaveLength(1)
    expect(records[0]?.uuid).toBe('honest')
    // One line on disk, whatever the payload tried to put in it.
    expect((await Bun.file(path).text()).trimEnd().split('\n')).toHaveLength(1)

    await rm(root, { recursive: true, force: true })
  })

  /** A killed process leaves one torn line; every earlier failure is still readable. */
  test('a half-written line is skipped, not fatal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-failed-'))
    const path = join(root, 'failed.jsonl')
    const store = new FileFailedJobStore(path)

    await store.log('redis', 'default', payload('one'), new Error('a'))
    await Bun.write(path, `${await Bun.file(path).text()}{"id":"torn","uu`)

    expect(await store.all()).toHaveLength(1)

    await rm(root, { recursive: true, force: true })
  })
})

/** The config promised this and the code kept them in memory. */
describe('the null failed-job store', () => {
  test('genuinely discards', async () => {
    const store = new NullFailedJobStore()

    await store.log('redis', 'default', payload('one'), new Error('boom'))

    expect(await store.all()).toEqual([])
  })
})
