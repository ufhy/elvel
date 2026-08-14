import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Application } from '@elysian/core'
import {
  ConcurrencyManager,
  ConcurrencyServiceProvider,
  SyncDriver,
  type TaskResult,
  WorkerDriver
} from '../src/index.ts'

const fixtures = resolve(import.meta.dir, 'fixtures', 'tasks.ts')

/** Both drivers must agree on everything except how long it takes. */
const drivers = [
  ['sync', () => new SyncDriver(import.meta.dir)],
  ['worker', () => new WorkerDriver(import.meta.dir)]
] as const

for (const [name, make] of drivers) {
  describe(`the ${name} driver`, () => {
    test('runs a list and keeps the order', async () => {
      const results = await make().run([
        { module: fixtures, export: 'add', args: [1, 2] },
        { module: fixtures, export: 'add', args: [10, 20] },
        { module: fixtures, export: 'add', args: [100, 200] }
      ])

      expect<unknown>(results).toEqual([3, 30, 300])
    })

    test('runs a record and keeps the keys', async () => {
      const results = await make().run({
        small: { module: fixtures, export: 'add', args: [1, 1] },
        large: { module: fixtures, export: 'add', args: [1000, 1] }
      })

      expect<unknown>(results).toEqual({ small: 2, large: 1001 })
    })

    test('calls the default export when none is named', async () => {
      expect<unknown>(await make().run([{ module: fixtures, args: ['ada'] }])).toEqual([
        'hello ada'
      ])
    })

    test('run() throws on a failure', async () => {
      await expect(make().run([{ module: fixtures, export: 'boom' }])).rejects.toThrow(
        'the task failed'
      )
    })

    test('settle() reports every outcome, not just the first failure', async () => {
      const results = (await make().settle([
        { module: fixtures, export: 'add', args: [1, 1] },
        { module: fixtures, export: 'boom' },
        { module: fixtures, export: 'add', args: [2, 2] }
      ])) as TaskResult<number>[]

      expect(results.map((result) => result.ok)).toEqual([true, false, true])
      // The two that worked are still reported, which Promise.all cannot do.
      expect(results[0]).toMatchObject({ ok: true, value: 2 })
      expect(results[2]).toMatchObject({ ok: true, value: 4 })
      expect((results[1] as { error: Error }).error.message).toContain('the task failed')
    })

    test('a failure is reported in declaration order, not completion order', async () => {
      // The later task fails faster; the earlier failure must still be the one
      // that surfaces, or which error you see depends on the machine.
      await expect(
        make().run([
          { module: fixtures, export: 'boom' },
          { module: fixtures, export: 'add', args: [1, 1] }
        ])
      ).rejects.toThrow('the task failed')
    })

    test('says so when the export does not exist', async () => {
      await expect(make().run([{ module: fixtures, export: 'nowhere' }])).rejects.toThrow(
        /no callable export \[nowhere\]/
      )
    })

    test('an empty list is an empty result', async () => {
      expect<unknown>(await make().run([])).toEqual([])
    })
  })
}

describe('the sync driver only', () => {
  test('runs a plain function, closure and all', async () => {
    const captured = 'from the enclosing scope'

    // Nothing crosses a boundary here, so a closure is safe — which is exactly
    // what makes sync a poor rehearsal for worker.
    expect<unknown>(await new SyncDriver().run([() => captured])).toEqual([captured])
  })

  test('a timeout bounds the wait, and says it timed out', async () => {
    const results = (await new SyncDriver().settle([() => Bun.sleep(5000)], {
      timeout: 100
    })) as TaskResult<unknown>[]

    expect(results[0]).toMatchObject({ ok: false, timedOut: true })
    expect((results[0] as { error: Error }).error.message).toMatch(/within 100ms/)
  })
})

describe('the worker driver only', () => {
  /**
   * The reason the package exists.
   *
   * The comparison is against `sync`, not against a multiplier: the same four
   * CPU-bound tasks, run one after another on this thread and across four
   * workers. Measured on an 8-core machine, 60M rounds each: 391ms for one
   * worker, 427ms for four (1.09x), 1556ms serial (3.8x). `Promise.all` would
   * score like the serial run — it interleaves waiting, and there is no waiting
   * here to interleave.
   *
   * The threshold is half, which the measurement clears by a wide margin and a
   * loaded machine will still meet.
   */
  test('genuinely uses more than one core', async () => {
    const task = { module: fixtures, export: 'spin', args: [40_000_000] }
    const four = [task, task, task, task]

    const serialStarted = Date.now()
    await new SyncDriver(import.meta.dir).run(four)
    const serial = Date.now() - serialStarted

    const parallelStarted = Date.now()
    await new WorkerDriver(import.meta.dir).run(four)
    const parallel = Date.now() - parallelStarted

    expect(parallel).toBeLessThan(serial / 2)
  })

  test('refuses a function, and says what to use instead', async () => {
    const captured = 'never arrives'

    const results = (await new WorkerDriver(import.meta.dir).settle([
      () => captured.toUpperCase()
    ])) as TaskResult<unknown>[]

    expect(results[0]?.ok).toBe(false)
    expect((results[0] as { error: Error }).error.message).toMatch(/cannot cross into a worker/)
    expect((results[0] as { error: Error }).error.message).toMatch(/const or let/)
  })

  test('refuses even a self-contained one, rather than guessing', async () => {
    // This would work. Accepting it would mean the rule is "sometimes", and a
    // caller cannot tell which case they have without reading the transpiler.
    const results = (await new WorkerDriver(import.meta.dir).settle([
      () => 6 * 7
    ])) as TaskResult<unknown>[]

    expect(results[0]?.ok).toBe(false)
  })

  test('a timeout terminates the thread rather than waiting for it', async () => {
    const started = Date.now()
    const results = (await new WorkerDriver(import.meta.dir).settle(
      [{ module: fixtures, export: 'forever' }],
      { timeout: 300 }
    )) as TaskResult<unknown>[]

    // An infinite loop cannot be interrupted from inside; a thread can be killed.
    expect(results[0]).toMatchObject({ ok: false, timedOut: true })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('a value that cannot be cloned fails as a task failure', async () => {
    const results = (await new WorkerDriver(import.meta.dir).settle([
      { module: fixtures, export: 'uncloneable' }
    ])) as TaskResult<unknown>[]

    // `structuredClone` decides what can come back; a function cannot.
    expect(results[0]?.ok).toBe(false)
  })
})

describe('the manager', () => {
  function managed(config: Record<string, unknown> = {}): ConcurrencyManager {
    const app = new Application(import.meta.dir)
    app.config.set('concurrency', { driver: 'sync', ...config })

    return new ConcurrencyManager(app)
  }

  test('uses the configured driver', async () => {
    expect(managed().driver()).toBeInstanceOf(SyncDriver)
    expect(managed({ driver: 'worker' }).driver()).toBeInstanceOf(WorkerDriver)
  })

  test('memoises drivers', () => {
    const manager = managed()

    expect(manager.driver()).toBe(manager.driver('sync'))
  })

  test('a custom driver can be registered', async () => {
    const manager = managed({ driver: 'counting' })
    let calls = 0

    manager.extend('counting', () => {
      calls += 1

      return new SyncDriver(import.meta.dir)
    })

    expect<unknown>(await manager.run([{ module: fixtures, export: 'add', args: [2, 3] }])).toEqual(
      [5]
    )
    expect(calls).toBe(1)
  })

  test('an unknown driver says how to add one', () => {
    expect(() => managed({ driver: 'threads' }).driver()).toThrow(/is not supported.*extend/s)
  })

  test('works without an application, defaulting to worker', () => {
    expect(new ConcurrencyManager().driver()).toBeInstanceOf(WorkerDriver)
  })
})

describe('the provider', () => {
  test('binds one manager for the application', async () => {
    const app = new Application(import.meta.dir)
    app.config.set('concurrency', { driver: 'sync' })
    await app.register(ConcurrencyServiceProvider)
    await app.boot()

    expect(app.make('concurrency')).toBe(app.make('concurrency'))
    expect<unknown>(
      await app.make('concurrency').run([{ module: fixtures, export: 'add', args: [7, 7] }])
    ).toEqual([14])
  })
})

describe('both drivers resolve a module the same way', () => {
  /**
   * A relative descriptor must mean the same file under either driver.
   *
   * It did not: `sync` used a bare `import()`, which resolves against the
   * driver's own source file, while `worker` resolved against the base path. The
   * same descriptor named two different modules, so changing driver changed which
   * code ran.
   */
  test('a path relative to the base path works under both', async () => {
    const relative = { module: './fixtures/tasks.ts', export: 'add', args: [4, 5] }

    expect<unknown>(await new SyncDriver(import.meta.dir).run([relative])).toEqual([9])
    expect<unknown>(await new WorkerDriver(import.meta.dir).run([relative])).toEqual([9])
  })
})
