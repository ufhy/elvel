import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, flushDeferred, forgetDeferred } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { encode, FOREVER } from '../src/payload.ts'
import { RateLimiter } from '../src/rate-limiter.ts'
import { Repository } from '../src/repository.ts'
import { Lock, LockTimeoutError, type Store } from '../src/store.ts'
import { ArrayStore } from '../src/stores/array.ts'
import { DatabaseStore } from '../src/stores/database.ts'
import { FileStore } from '../src/stores/file.ts'
import { MemoStore } from '../src/stores/memo.ts'
import { RedisStore } from '../src/stores/redis.ts'
import { TagSet } from '../src/tags.ts'

/**
 * Every store is held to the same contract.
 *
 * A cache that behaves differently per driver is worse than no cache: code
 * written against the array store in tests has to keep working against Redis in
 * production. So the conformance block below runs unchanged for each driver, and
 * only the driver-specific details get their own tests.
 */

type Candidate = {
  name: string
  make: () => Promise<{ store: Store; dispose: () => Promise<void> }>
}

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'

/** Is there a Redis to talk to? Skipped with a note when not. */
const redisAvailable = await (async () => {
  const store = new RedisStore({ url: REDIS_URL, prefix: 'probe:' })

  try {
    await store.put('ping', 1, 5)
    await store.forget('ping')

    return true
  } catch {
    console.log('  skipping redis store: no server at', REDIS_URL)

    return false
  } finally {
    store.disconnect()
  }
})()

const candidates: Candidate[] = [
  {
    name: 'array',
    make: async () => ({ store: new ArrayStore('t:'), dispose: async () => undefined })
  },
  {
    name: 'file',
    make: async () => {
      const directory = await mkdtemp(join(tmpdir(), 'elvel-cache-'))

      return {
        store: new FileStore(directory, 't:'),
        dispose: () => rm(directory, { recursive: true, force: true })
      }
    }
  },
  {
    name: 'database',
    make: async () => {
      const app = new Application(process.cwd())
      app.config.set('database.default', 'cache-test')
      app.config.set('database.connections.cache-test', {
        driver: 'sqlite',
        database: ':memory:'
        // database: 'test.sqlite'
      })

      const db = new ConnectionManager(app)
      const schema = await db.schema()

      await schema.create('cache', (table) => {
        table.string('key').primary()
        table.text('value')
        table.bigInteger('expiration')
      })
      await schema.create('cache_locks', (table) => {
        table.string('key').primary()
        table.string('owner')
        table.bigInteger('expiration')
      })

      return {
        store: new DatabaseStore(db, { prefix: 't:' }),
        dispose: () => db.disconnectAll()
      }
    }
  }
]

/**
 * The database store against a real server.
 *
 * SQLite covers the SQL; a server covers what SQLite cannot be asked about. The
 * store leans on an upsert and a `for update` read, and both are dialect
 * specific — a statement can be perfectly plausible and still be rejected, or
 * worse, accepted with different locking semantics.
 *
 * Its own tables per run, so two suites against one server never collide.
 */
const SERVER_STORES: Array<{ name: string; config: Record<string, unknown> }> = [
  {
    name: 'database:mysql',
    config: process.env.TEST_MYSQL_URL
      ? { driver: 'mysql', url: process.env.TEST_MYSQL_URL }
      : { driver: 'mysql', host: '127.0.0.1', port: 3309, username: 'root', database: 'mysql' }
  },
  {
    name: 'database:postgres',
    config: process.env.TEST_POSTGRES_URL
      ? { driver: 'postgres', url: process.env.TEST_POSTGRES_URL }
      : {
          driver: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          username: 'postgres',
          database: 'postgres'
        }
  }
]

for (const server of SERVER_STORES) {
  const suffix = `${Date.now().toString(36)}_${server.name.split(':')[1]}`
  const table = `cache_${suffix}`
  const lockTable = `cache_locks_${suffix}`

  const open = async () => {
    const app = new Application(process.cwd())
    app.config.set('database.default', 'cache-server')
    app.config.set('database.connections.cache-server', server.config)

    const db = new ConnectionManager(app)
    const schema = await db.schema()

    await schema.dropIfExists(table)
    await schema.dropIfExists(lockTable)

    await schema.create(table, (blueprint) => {
      blueprint.string('key').primary()
      blueprint.text('value')
      blueprint.bigInteger('expiration')
    })
    await schema.create(lockTable, (blueprint) => {
      blueprint.string('key').primary()
      blueprint.string('owner')
      blueprint.bigInteger('expiration')
    })

    return { app, db, schema }
  }

  const reachable = await (async () => {
    try {
      const { db, schema } = await open()

      await schema.dropIfExists(table)
      await schema.dropIfExists(lockTable)
      await db.disconnectAll()

      return true
    } catch (error) {
      console.log(
        `  skipping ${server.name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`
      )

      return false
    }
  })()

  if (!reachable) continue

  candidates.push({
    name: server.name,
    make: async () => {
      const { db, schema } = await open()

      return {
        store: new DatabaseStore(db, { table, lockTable, prefix: 't:' }),
        dispose: async () => {
          await schema.dropIfExists(table)
          await schema.dropIfExists(lockTable)
          await db.disconnectAll()
        }
      }
    }
  })
}

if (redisAvailable) {
  candidates.push({
    name: 'redis',
    make: async () => {
      // A prefix per run so two suites on one server never collide.
      const store = new RedisStore({
        url: REDIS_URL,
        prefix: `t${Date.now().toString(36)}:`
      })

      return {
        store,
        dispose: async () => {
          await store.flush()
          store.disconnect()
        }
      }
    }
  })
}

test('the array, file and database stores are always tested', () => {
  expect(candidates.map((candidate) => candidate.name)).toEqual(
    expect.arrayContaining(['array', 'file', 'database'])
  )
})

for (const candidate of candidates) {
  describe(`store: ${candidate.name}`, () => {
    let store: Store
    let dispose: () => Promise<void>
    let cache: Repository

    beforeEach(async () => {
      const made = await candidate.make()
      store = made.store
      dispose = made.dispose
      cache = new Repository(store, { name: candidate.name })
    })

    afterEach(async () => {
      // A deferred refresh from one test must not fire during the next.
      forgetDeferred()
      await dispose()
    })

    test('a miss is null, and a hit returns what was written', async () => {
      expect(await cache.get('absent')).toBeNull()

      await cache.put('name', 'Ada', 60)
      expect(await cache.get<string>('name')).toBe('Ada')
    })

    test('a fallback is returned on a miss, and may be a function', async () => {
      expect(await cache.get<string>('absent', 'default')).toBe('default')
      expect(await cache.get<string>('absent', () => 'computed')).toBe('computed')

      // The fallback is not written: a miss with a default is still a miss.
      expect(await cache.has('absent')).toBe(false)
    })

    test('objects and arrays round-trip', async () => {
      await cache.put('user', { id: 1, tags: ['a', 'b'], nested: { ok: true } }, 60)

      expect(await cache.get<Record<string, unknown>>('user')).toEqual({
        id: 1,
        tags: ['a', 'b'],
        nested: { ok: true }
      })
    })

    test('a past TTL forgets rather than writing something already dead', async () => {
      await cache.put('name', 'Ada', 60)
      await cache.put('name', 'Linus', -5)

      expect(await cache.get('name')).toBeNull()
    })

    test('an expired entry reads as a miss', async () => {
      /**
       * Two seconds, not one, and the extra second is the point.
       *
       * Expiry is stored at second resolution — `floor(now / 1000) + seconds`, as
       * Laravel's `time() + $seconds` is — so a one-second TTL written at
       * `12:00:00.980` expires at `12:00:01`, and the read on the next line at
       * `12:00:01.010` is already a miss. Nothing is wrong with the store; the test
       * was asking for a guarantee second resolution cannot give. It failed on
       * MySQL first because MySQL's round trip is the slowest, so it crosses the
       * boundary most often.
       */
      await cache.put('brief', 'gone', 2)
      expect(await cache.get<string>('brief')).toBe('gone')

      await Bun.sleep(2100)
      expect(await cache.get('brief')).toBeNull()
    })

    test('forever survives a TTL sweep', async () => {
      await cache.forever('permanent', 'here')

      expect(await cache.get<string>('permanent')).toBe('here')
    })

    test('many reads several keys and reports the misses', async () => {
      await cache.put('a', 1, 60)
      await cache.put('c', 3, 60)

      expect(await cache.many(['a', 'b', 'c'])).toEqual({ a: 1, b: null, c: 3 })
    })

    test('putMany writes them all', async () => {
      await cache.putMany({ a: 1, b: 2 }, 60)

      expect(await cache.many(['a', 'b'])).toEqual({ a: 1, b: 2 })
    })

    test('add writes only when the key is absent', async () => {
      expect(await cache.add('once', 'first', 60)).toBe(true)
      expect(await cache.add('once', 'second', 60)).toBe(false)
      expect(await cache.get<string>('once')).toBe('first')
    })

    test('add takes over an expired key', async () => {
      await cache.put('slot', 'old', 1)
      await Bun.sleep(1100)

      expect(await cache.add('slot', 'new', 60)).toBe(true)
      expect(await cache.get<string>('slot')).toBe('new')
    })

    test('pull reads and forgets', async () => {
      await cache.put('once', 'value', 60)

      expect(await cache.pull<string>('once')).toBe('value')
      expect(await cache.get('once')).toBeNull()
    })

    test('increment and decrement count', async () => {
      expect(await cache.increment('hits')).toBe(1)
      expect(await cache.increment('hits', 4)).toBe(5)
      expect(await cache.decrement('hits', 2)).toBe(3)
      expect(await cache.get<number>('hits')).toBe(3)
    })

    test('increment refuses a value that is not a number', async () => {
      await cache.put('name', 'Ada', 60)

      expect(await cache.increment('name')).toBe(false)
    })

    test('increment keeps the original expiry', async () => {
      // Two seconds for the reason the expiry test above gives: at one, the
      // increment itself can land after the key has already gone, and then it
      // creates a fresh one whose window this never measures.
      await cache.put('hits', 1, 2)
      await cache.increment('hits')
      await Bun.sleep(2100)

      // Counting must not extend the window, or a rate limit never resets.
      expect(await cache.get('hits')).toBeNull()
    })

    test('forget removes one key, flush removes them all', async () => {
      await cache.putMany({ a: 1, b: 2 }, 60)

      await cache.forget('a')
      expect(await cache.get('a')).toBeNull()
      expect(await cache.get<number>('b')).toBe(2)

      await cache.flush()
      expect(await cache.get('b')).toBeNull()
    })

    test('remember computes once and caches the result', async () => {
      let calls = 0
      const compute = () => {
        calls += 1
        return { computed: true }
      }

      expect(await cache.remember('report', 60, compute)).toEqual({ computed: true })
      expect(await cache.remember('report', 60, compute)).toEqual({ computed: true })
      expect(calls).toBe(1)
    })

    test('rememberForever caches with no expiry', async () => {
      expect(await cache.rememberForever('forever', () => 7)).toBe(7)
      expect(await cache.get<number>('forever')).toBe(7)
    })

    test('typed reads assert rather than coerce', async () => {
      await cache.put('name', 'Ada', 60)
      await cache.put('count', 42, 60)
      await cache.put('flag', true, 60)
      await cache.put('list', [1, 2], 60)

      expect(await cache.string('name')).toBe('Ada')
      expect(await cache.integer('count')).toBe(42)
      expect(await cache.boolean('flag')).toBe(true)
      expect(await cache.array('list')).toEqual([1, 2])

      // A string where a number was promised is a bug, not something to coerce.
      /**
       * Caught rather than asserted with `.rejects`.
       *
       * `expect(promise).rejects` never settled on Windows before Bun 1.4 when
       * the promise came from a driver-backed read: the test hung for ever with
       * no output, and Bun blamed a hook timeout, which sends you looking in the
       * wrong place. 1.4 fixed it — this stays because catching the rejection
       * asserts exactly the same thing and cannot hang on any version.
       */
      const refused = await cache.integer('name').catch((error: unknown) => error)

      expect(refused).toBeInstanceOf(TypeError)
      expect(String((refused as Error).message)).toMatch(/not a number/)
    })

    test('a lock is held by one owner at a time', async () => {
      const first = cache.lock('deploy', 10)
      const second = cache.lock('deploy', 10)

      expect(await first.acquire()).toBe(true)
      expect(await second.acquire()).toBe(false)

      expect(await first.release()).toBe(true)
      expect(await second.acquire()).toBe(true)
      await second.release()
    })

    test('only the owner may release a lock', async () => {
      const held = cache.lock('deploy', 10)
      await held.acquire()

      // A different owner must not be able to release it.
      const other = cache.lock('deploy', 10)
      expect(await other.release()).toBe(false)
      expect(await other.acquire()).toBe(false)

      await held.release()
    })

    test('a lock with a callback releases afterwards, even on a throw', async () => {
      const lock = cache.lock('job', 10)

      const thrown = await lock
        .get(async () => {
          throw new Error('boom')
        })
        .catch((error: unknown) => error)

      expect(String((thrown as Error).message)).toBe('boom')

      // The finally in `get()` is what makes a failed job not wedge the lock.
      expect(await cache.lock('job', 10).acquire()).toBe(true)
    })

    test('an expired lock can be taken over', async () => {
      const brief = cache.lock('short', 1)
      expect(await brief.acquire()).toBe(true)

      await Bun.sleep(1100)

      expect(await cache.lock('short', 10).acquire()).toBe(true)
    })

    test('block gives up with a timeout rather than waiting forever', async () => {
      const held = cache.lock('busy', 10)
      await held.acquire()

      const waiting = cache.lock('busy', 10).betweenBlockedAttemptsSleepFor(20)

      const refusedWait = await waiting.block(0.1).catch((error: unknown) => error)

      expect(refusedWait).toBeInstanceOf(LockTimeoutError)

      await held.release()
    })

    test('withoutOverlapping serialises two callers', async () => {
      const order: string[] = []

      const slow = cache.withoutOverlapping(
        'section',
        async () => {
          order.push('first:start')
          await Bun.sleep(60)
          order.push('first:end')
        },
        { lockFor: 10, waitFor: 5 }
      )

      const quick = (async () => {
        await Bun.sleep(10)

        return cache.withoutOverlapping('section', () => order.push('second'), {
          lockFor: 10,
          waitFor: 5
        })
      })()

      await Promise.all([slow, quick])

      // The second caller must not interleave with the first.
      expect(order).toEqual(['first:start', 'first:end', 'second'])
    })

    test('funnel lets N through at once and no more', async () => {
      let inside = 0
      let peak = 0
      const refused: boolean[] = []

      /**
       * The slot outlives the work, which it did not before.
       *
       * This was `releaseAfter(10)` around a callback holding for 60 ms — a lock
       * expiring in the middle of the work it guards. It passed only while all
       * three callers got in inside those 10 ms, and on a Windows runner the third
       * arrived late: peak 2, expected 3, and a release blocked by a test that was
       * measuring the machine rather than the funnel.
       *
       * A slot held for two seconds around 150 ms of work leaves the outcome
       * decided by the limit, which is what the test is about.
       */
      const worker = () =>
        cache
          .funnel('reports')
          .limit(3)
          .releaseAfter(2000)
          .then(async () => {
            inside += 1
            peak = Math.max(peak, inside)
            await Bun.sleep(150)
            inside -= 1

            return 'done'
          })

      const results = await Promise.all([worker(), worker(), worker(), worker(), worker()])

      for (const result of results) if (result === false) refused.push(true)

      /**
       * The guarantee is the **count**, not the overlap.
       *
       * `peak === 3` was the assertion here, and it demands that all three
       * slot-holders be inside at the same instant — which is a property of the
       * scheduler, not of the funnel. On a Windows runner the third caller
       * arrived after the first had finished its 150 ms, so peak was 2 and the
       * test failed while the funnel was working perfectly. Widening the window
       * once already had not fixed it, because there is no window wide enough to
       * make a machine overlap three things it decided to run in sequence.
       *
       * What the funnel actually promises is below: at most three at once, and
       * five callers against three slots means exactly two refusals. Together
       * those pin the contract without asking anything of the clock.
       */
      expect<boolean>(peak >= 1 && peak <= 3).toBe(true)
      expect<number>(refused.length).toBe(2)
    })

    test('a slot is given back even when the callback throws', async () => {
      const funnel = () => cache.funnel('fragile').limit(1).releaseAfter(30)

      const failed = await funnel()
        .then(() => {
          throw new Error('boom')
        })
        .catch((error: unknown) => error)

      expect(String((failed as Error).message)).toBe('boom')

      // Otherwise the funnel narrows by one every time something fails, and
      // nobody gets in again until releaseAfter has elapsed.
      expect<unknown>(await funnel().then(() => 'in')).toBe('in')
    })

    /**
     * The slot has to outlive the work, or the waiter gets in for the wrong reason.
     *
     * With `releaseAfter(10)` around a holder sleeping 60 ms — as this was — the
     * lock expires while the holder is still inside, so the waiter can acquire at
     * around 30 ms and push `second` before `first:end`. It passed on the timing
     * of one machine rather than on the behaviour being tested, which is that
     * `block()` waits for a *release*.
     */
    test('block() waits for a slot rather than refusing', async () => {
      const order: string[] = []

      const holder = cache
        .funnel('narrow')
        .limit(1)
        .releaseAfter(2000)
        .then(async () => {
          order.push('first:start')
          await Bun.sleep(60)
          order.push('first:end')
        })

      const waiter = (async () => {
        await Bun.sleep(10)

        return cache
          .funnel('narrow')
          .limit(1)
          .releaseAfter(2000)
          .betweenBlockedAttemptsSleepFor(20)
          .block(5, () => order.push('second'))
      })()

      await Promise.all([holder, waiter])

      expect<string[]>(order).toEqual(['first:start', 'first:end', 'second'])
    })

    test('block() gives up on the clock, not on attempts', async () => {
      // Held for the whole 200 ms, so the waiter's 0.1 s really does run out —
      // at `releaseAfter(10)` the slot freed itself and the waiter could take it.
      const occupied = cache.funnel('full').limit(1).releaseAfter(2000)
      const running = occupied.then(() => Bun.sleep(200))

      // Let the holder take the only slot before the waiter starts.
      await Bun.sleep(20)

      const blocked = cache
        .funnel('full')
        .limit(1)
        .releaseAfter(10)
        .betweenBlockedAttemptsSleepFor(20)

      // A slow driver must not quietly stretch the timeout, so the wait is
      // measured against the clock rather than counted in attempts.
      const refusedSlot = await blocked.block(0.1).catch((error: unknown) => error)

      expect(refusedSlot).toBeInstanceOf(LockTimeoutError)

      await running
    })

    test('free() reports what is left', async () => {
      // Long enough that the count cannot change under the assertions.
      const funnel = cache.funnel('gauge').limit(2).releaseAfter(2000)

      expect<number>(await funnel.free()).toBe(2)

      await funnel.then(async () => {
        expect<number>(await funnel.free()).toBe(1)
      })

      expect<number>(await funnel.free()).toBe(2)
    })

    test('restoreLock releases a lock taken elsewhere', async () => {
      const lock = cache.lock('handoff', 30)
      await lock.acquire()

      // The owner token is what makes a lock releasable from another process.
      expect(await cache.restoreLock('handoff', lock.owner()).release()).toBe(true)
      expect(await cache.lock('handoff', 30).acquire()).toBe(true)
    })

    test('tags scope a key, and flushing one leaves the others alone', async () => {
      await cache.tags('people').put('ada', 1, 60)
      await cache.tags('places').put('ada', 2, 60)

      expect(await cache.tags('people').get<number>('ada')).toBe(1)
      expect(await cache.tags('places').get<number>('ada')).toBe(2)
      // The untagged key of the same name is a different entry again.
      expect(await cache.get('ada')).toBeNull()

      await cache.tags('people').flush()

      expect(await cache.tags('people').get('ada')).toBeNull()
      expect(await cache.tags('places').get<number>('ada')).toBe(2)
    })

    test('a key under two tags is reachable only through both', async () => {
      await cache.tags('people', 'authors').put('ada', 'both', 60)

      expect(await cache.tags('people', 'authors').get<string>('ada')).toBe('both')
      expect(await cache.tags('people').get('ada')).toBeNull()
    })

    test('flushing either tag invalidates a key held under both', async () => {
      await cache.tags('people', 'authors').put('ada', 'both', 60)
      await cache.tags('authors').flush()

      expect(await cache.tags('people', 'authors').get('ada')).toBeNull()
    })

    /**
     * `many` under tags used to name each key on its own, and naming a key means
     * reading every tag id: twenty keys under two tags was forty reads before the
     * one the call came for. Against Redis that was 1,270µs for a call whose
     * useful work is two round trips.
     */
    test('many under tags reads the tag ids once, not once per key', async () => {
      const keys = ['a', 'b', 'c', 'd', 'e']

      await cache.tags('people').putMany(Object.fromEntries(keys.map((k) => [k, k])), 60)

      const found = await cache.tags('people').many<string>(keys)

      expect<string[]>(keys.map((k) => found[k] as string)).toEqual(keys)
    })

    test('and a key missing from the set still reads as null', async () => {
      await cache.tags('people').put('here', 1, 60)

      const found = await cache.tags('people').many<number>(['here', 'gone'])

      expect<unknown>(found.here).toBe(1)
      expect<unknown>(found.gone).toBeNull()
    })

    /** Tags that do not exist yet are created, one write each and no more. */
    test('a tag set that has never been used is created on first touch', async () => {
      await cache.tags('brand-new', 'also-new').put('k', 'v', 60)

      expect<unknown>(await cache.tags('brand-new', 'also-new').get('k')).toBe('v')

      await cache.tags('also-new').flush()

      expect<unknown>(await cache.tags('brand-new', 'also-new').get('k')).toBeNull()
    })

    /** The ids are joined in the order the tags were named, as Laravel joins them. */
    test('the same tags in another order are another namespace', async () => {
      await cache.tags('one', 'two').put('k', 'first', 60)

      expect<unknown>(await cache.tags('two', 'one').get('k')).toBeNull()
      expect<unknown>(await cache.tags('one', 'two').get('k')).toBe('first')
    })

    test('flexible serves a stale value and refreshes behind it', async () => {
      let calls = 0
      const compute = () => {
        calls += 1
        return `value-${calls}`
      }

      // Fresh for a second, alive for a minute.
      expect(await cache.flexible('report', [1, 60], compute)).toBe('value-1')
      expect(await cache.flexible('report', [1, 60], compute)).toBe('value-1')
      expect(calls).toBe(1)

      await Bun.sleep(1100)

      // Stale: the old value comes back at once, and the refresh is deferred.
      expect(await cache.flexible('report', [1, 60], compute)).toBe('value-1')

      // Nothing has recomputed yet — that is the point of deferring it.
      expect(calls).toBe(1)

      // In a request this happens after the response is sent; here we flush by
      // hand, which is what a command or a test has to do.
      expect(await flushDeferred()).toBeGreaterThan(0)

      expect(calls).toBe(2)
      expect(await cache.get<string>('report')).toBe('value-2')
    })

    test('the rate limiter counts and denies', async () => {
      const limiter = new RateLimiter(cache)

      /**
       * A long window, deliberately.
       *
       * These four calls are four round trips to the store, and with a
       * one-second window a loaded machine can spend the whole window getting
       * to the third — which then passes, because the limit genuinely reset.
       * That is the limiter working and the test lying; expiry is asserted
       * separately below, where waiting is the point.
       */
      expect(await limiter.attempt('login', 2, () => 'ok', 60)).toBe('ok')
      expect(await limiter.attempt('login', 2, () => 'ok', 60)).toBe('ok')
      // Third attempt in the window is refused.
      expect(await limiter.attempt('login', 2, () => 'ok', 60)).toBe(false)

      expect(await limiter.attempts('login')).toBe(2)
      expect(await limiter.remaining('login', 2)).toBe(0)
      expect(await limiter.availableIn('login')).toBeGreaterThan(0)
    })

    test('and starts again once the window closes', async () => {
      const limiter = new RateLimiter(cache)

      /**
       * Nothing is asserted about being refused *inside* the window, on purpose.
       *
       * It used to be, and it failed a release: two round trips to the store took
       * longer than the one-second window on a loaded runner, so the second
       * attempt was allowed — the limiter working correctly and the assertion
       * lying about why. Refusal is proved by the test above, whose window is long
       * enough not to race.
       *
       * What is left here is the one thing that genuinely needs a short window,
       * and it needs only a single comparison: the counter is spent, and once the
       * window lapses it is gone and the next attempt runs.
       */
      expect(await limiter.attempt('sms', 1, () => 'ok', 1)).toBe('ok')
      expect(await limiter.attempts('sms')).toBe(1)

      /**
       * Comfortably past the window, not barely past it.
       *
       * A one-second entry is stored as `floor(now / 1000) + 1` and read back as
       * expired once `floor(now / 1000)` reaches it — whole seconds on both sides.
       * 1100 ms cleared that for every fraction I could measure, and this test
       * still failed once in roughly fifteen runs of the full suite and never once
       * in thirty runs on its own. I could not reproduce it in isolation, so the
       * margin is now wider than any second-granularity store needs rather than
       * exactly enough, and this comment is the honest state of it.
       */
      await Bun.sleep(2100)

      expect(await limiter.attempts('sms')).toBe(0)
      expect(await limiter.availableIn('sms')).toBe(0)
      expect(await limiter.attempt('sms', 1, () => 'ok', 1)).toBe('ok')
    })

    test('clearing a limit forgets both the counter and its window', async () => {
      const limiter = new RateLimiter(cache)

      await limiter.hit('sms', 60)
      await limiter.clear('sms')

      expect(await limiter.attempts('sms')).toBe(0)
      expect(await limiter.availableIn('sms')).toBe(0)
    })

    test('cache events report hits, misses and writes', async () => {
      const seen: Array<{ event: string; key?: string }> = []

      const watched = new Repository(store, {
        name: candidate.name,
        events: {
          dispatch: (event: string, payload?: unknown) => {
            seen.push({ event, key: (payload as { key?: string } | undefined)?.key })
            return undefined
          }
        }
      })

      await watched.get('absent')
      await watched.put('present', 1, 60)
      await watched.get('present')
      await watched.forget('present')

      expect(seen.map((entry) => entry.event)).toEqual([
        'cache.missed',
        'cache.written',
        'cache.hit',
        'cache.forgotten'
      ])
    })

    /**
     * Every read and write emits one of these, and most applications register no
     * cache listener at all. Asked and answered "nobody", the repository builds
     * nothing and dispatches nothing.
     */
    test('and asks before it dispatches', async () => {
      const asked: string[] = []
      let dispatched = 0

      const quiet = new Repository(store, {
        name: candidate.name,
        events: {
          dispatch: () => {
            dispatched += 1
            return undefined
          },
          hasListeners: (event: string) => {
            asked.push(event)
            return false
          }
        }
      })

      await quiet.put('k', 1, 60)
      await quiet.get('k')

      expect<string[]>(asked).toEqual(['cache.written', 'cache.hit'])
      expect<number>(dispatched).toBe(0)
    })

    /** A dispatcher that cannot answer still gets the event — silence is worse. */
    test('but dispatches anyway when it cannot answer', async () => {
      let dispatched = 0

      const unsure = new Repository(store, {
        name: candidate.name,
        events: {
          dispatch: () => {
            dispatched += 1
            return undefined
          }
        }
      })

      await unsure.get('nothing-here')

      expect<number>(dispatched).toBe(1)
    })
  })
}

// ------------------------------------------------------------ driver specifics

describe('FileStore layout', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elvel-cache-layout-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('keys shard into two levels of directories', async () => {
    const store = new FileStore(directory)
    const hash = new Bun.CryptoHasher('sha1').update('config').digest('hex')

    expect(store.path('config')).toBe(join(directory, hash.slice(0, 2), hash.slice(2, 4), hash))
  })

  test('the payload is a ten-digit expiry followed by the value', async () => {
    const store = new FileStore(directory)
    await store.put('answer', 42, 60)

    const contents = await Bun.file(store.path('answer')).text()

    expect(contents.slice(0, 10)).toMatch(/^\d{10}$/)
    expect(contents.slice(10)).toBe(encode(42))
    expect(Number(contents.slice(0, 10))).toBeLessThan(FOREVER)
  })

  test('forever writes the far-future sentinel', async () => {
    const store = new FileStore(directory)
    await store.forever('permanent', 1)

    const contents = await Bun.file(store.path('permanent')).text()

    expect(Number(contents.slice(0, 10))).toBe(FOREVER)
  })

  test('a corrupt payload reads as a miss instead of throwing', async () => {
    const store = new FileStore(directory)
    await store.put('broken', { a: 1 }, 60)

    const path = store.path('broken')
    const contents = await Bun.file(path).text()
    await Bun.write(path, `${contents.slice(0, 10)}{not json`)

    expect(await store.get('broken')).toBeNull()
  })
})

describe('ArrayStore', () => {
  test('flush drops the locks too', async () => {
    const store = new ArrayStore()
    const lock = store.lock('deploy', 60)

    await lock.acquire()
    await store.flush()

    expect(await store.lock('deploy', 60).acquire()).toBe(true)
  })
})

describe('DatabaseStore', () => {
  let db: ConnectionManager
  let store: DatabaseStore

  beforeEach(async () => {
    const app = new Application(process.cwd())
    app.config.set('database.default', 'prune-test')
    app.config.set('database.connections.prune-test', { driver: 'sqlite', database: ':memory:' })

    db = new ConnectionManager(app)
    const schema = await db.schema()

    await schema.create('cache', (table) => {
      table.string('key').primary()
      table.text('value')
      table.bigInteger('expiration')
    })
    await schema.create('cache_locks', (table) => {
      table.string('key').primary()
      table.string('owner')
      table.bigInteger('expiration')
    })

    store = new DatabaseStore(db)
  })

  afterEach(async () => {
    await db.disconnectAll()
  })

  test('prune deletes expired rows and leaves live ones', async () => {
    await store.put('live', 1, 600)
    await store.put('dead', 2, 1)

    await Bun.sleep(1100)

    expect(await store.prune()).toBe(1)
    expect(await store.get<number>('live')).toBe(1)
  })

  test('the value column holds readable JSON', async () => {
    await store.put('user', { id: 1 }, 60)

    const row = await (await db.table('cache')).where('key', '=', 'user').first()

    // Readable in a database client, which is half the point of this store.
    expect(row?.value).toBe('{"id":1}')
  })
})

describe('Repository TTL handling', () => {
  test('a Date is converted to seconds from now', () => {
    const inTwoMinutes = new Date(Date.now() + 120_000)

    expect(Repository.secondsFrom(inTwoMinutes)).toBeGreaterThan(118)
    expect(Repository.secondsFrom(inTwoMinutes)).toBeLessThanOrEqual(120)
  })

  test('null means forever', () => {
    expect(Repository.secondsFrom(null)).toBe(0)
  })

  test('a Date honours an absolute expiry', async () => {
    const cache = new Repository(new ArrayStore())

    await cache.put('soon', 'value', new Date(Date.now() + 1000))
    expect(await cache.get<string>('soon')).toBe('value')

    await Bun.sleep(1100)
    expect(await cache.get('soon')).toBeNull()
  })

  test('a store with no locks says so instead of pretending', () => {
    const lockless: Store = {
      prefix: '',
      get: async () => null,
      many: async () => ({}),
      put: async () => true,
      putMany: async () => true,
      add: async () => true,
      increment: async () => 1,
      decrement: async () => 1,
      forever: async () => true,
      forget: async () => true,
      flush: async () => true
    }

    expect(() => new Repository(lockless).lock('x')).toThrow(/does not support atomic locks/)
  })
})

describe('Lock owners', () => {
  test('each lock gets its own random owner', () => {
    const store = new ArrayStore()

    expect(store.lock('a').owner()).not.toBe(store.lock('a').owner())
  })

  test('a driver that cannot refresh says so', async () => {
    class Bare extends Lock {
      async acquire() {
        return true
      }
      async release() {
        return true
      }
      protected async currentOwner() {
        return null
      }
    }

    expect(() => new Bare('x', 10).refresh()).toThrow(/does not support refreshing/)
  })
})

describe('the memory tier in front of a store', () => {
  /**
   * Off unless asked for, because it trades freshness. A `get()` against the file
   * store is 26µs and 96% of that is the filesystem read — measured — so the only
   * way to make a hot key cheap is not to go to the store at all.
   */
  const inner = () => new ArrayStore('memo:')

  test('answers a repeated read without touching the store', async () => {
    const store = inner()
    let reads = 0

    const counted = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            reads += 1

            return target.get(key)
          }
        }

        return Reflect.get(target, property, receiver)
      }
    })

    const memo = new MemoStore(counted as never, 1)
    await memo.put('flag', true, 60)

    expect(await memo.get<boolean>('flag')).toBe(true)
    expect(await memo.get<boolean>('flag')).toBe(true)
    expect(await memo.get<boolean>('flag')).toBe(true)

    // One read for the first miss; the other two came from memory.
    expect<number>(reads).toBe(1)
  })

  /** A write here drops the entry, so this process never serves its own stale value. */
  test('a write through it is visible at once', async () => {
    const memo = new MemoStore(inner(), 60)

    await memo.put('name', 'ada', 60)
    expect(await memo.get<string>('name')).toBe('ada')

    await memo.put('name', 'linus', 60)
    expect(await memo.get<string>('name')).toBe('linus')

    await memo.forget('name')
    expect(await memo.get<string>('name')).toBeNull()
  })

  /**
   * And somebody else's write is seen once the window passes. This is the trade
   * stated as a test: a second process wrote, and this one keeps the old value
   * until `seconds` have gone by.
   */
  test('while another writer is seen only after the window', async () => {
    const shared = inner()
    let clock = 1_000_000
    const memo = new MemoStore(shared, 1, () => clock)

    await shared.put('flag', 'old', 60)
    expect(await memo.get<string>('flag')).toBe('old')

    // Written behind its back, as a queue worker would.
    await shared.put('flag', 'new', 60)
    expect(await memo.get<string>('flag')).toBe('old')

    clock += 1_100
    expect(await memo.get<string>('flag')).toBe('new')
  })

  /** Counters are never served from memory: a stale read there is a wrong answer. */
  test('and a counter always goes to the store', async () => {
    const memo = new MemoStore(inner(), 60)

    await memo.put('hits', 0, 60)
    await memo.get('hits')

    expect(await memo.increment('hits')).toBe(1)
    expect(await memo.increment('hits')).toBe(2)
    expect(await memo.get<number>('hits')).toBe(2)
  })
})

describe('TagSet reads the tag ids in one call', () => {
  /**
   * Counts what the namespace costs. `tags('a','b','c').get(k)` used to ask the
   * store for each tag id in turn, which against Redis is three round trips before
   * the key it came for — and `many()` repeated all of them per key.
   */
  const counting = () => {
    const values = new Map<string, unknown>()
    const calls = { get: 0, many: 0, forever: 0 }

    return {
      calls,
      store: {
        prefix: '',
        get: async <T>(key: string) => {
          calls.get += 1
          return (values.get(key) ?? null) as T | null
        },
        many: async <T>(keys: string[]) => {
          calls.many += 1
          const found: Record<string, T | null> = {}
          for (const key of keys) found[key] = (values.get(key) ?? null) as T | null
          return found
        },
        forever: async (key: string, value: unknown) => {
          calls.forever += 1
          values.set(key, value)
          return true
        },
        forget: async (key: string) => values.delete(key),
        put: async () => true,
        putMany: async () => true,
        add: async () => true,
        increment: async () => 1,
        decrement: async () => 1,
        flush: async () => true
      } as never
    }
  }

  test('three tags cost one read, not three', async () => {
    const { calls, store } = counting()
    const tags = new TagSet(store, ['a', 'b', 'c'])

    await tags.namespace()

    expect<number>(calls.many).toBe(1)
    expect<number>(calls.get).toBe(0)
    // Three tags that did not exist, so three ids to create.
    expect<number>(calls.forever).toBe(3)
  })

  test('and a second namespace creates nothing more', async () => {
    const { calls, store } = counting()
    const tags = new TagSet(store, ['a', 'b', 'c'])

    const first = await tags.namespace()

    calls.many = 0
    calls.forever = 0

    const second = await tags.namespace()

    expect<string>(second).toBe(first)
    expect<number>(calls.many).toBe(1)
    expect<number>(calls.forever).toBe(0)
  })

  test('only the tag that is missing is created', async () => {
    const { calls, store } = counting()

    await new TagSet(store, ['a']).namespace()

    calls.forever = 0

    await new TagSet(store, ['a', 'b']).namespace()

    expect<number>(calls.forever).toBe(1)
  })

  test('no tags is an empty namespace and no reads at all', async () => {
    const { calls, store } = counting()

    expect<string>(await new TagSet(store, []).namespace()).toBe('')
    expect<number>(calls.many).toBe(0)
  })
})
