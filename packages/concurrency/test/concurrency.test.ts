import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Application } from '@elvel/core'
import {
  ConcurrencyManager,
  ConcurrencyServiceProvider,
  SyncDriver,
  type TaskResult,
  WorkerDriver
} from '../src/index.ts'
import { specifierFor } from '../src/specifier.ts'

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
   * Two CPU-bound tasks, each reporting the window it ran in. `Promise.all`
   * cannot make these overlap — it interleaves waiting, and there is no waiting
   * here to interleave — so an overlap is proof of a second thread and nothing
   * else. For scale: on an 8-core machine at 60M rounds each, four workers take
   * 427ms against 1556ms serial.
   *
   * Two thresholds were tried before this and both measured the machine rather
   * than the code. `parallel < serial / 2` asked for the theoretical best and
   * failed on a two-core runner; `< serial * 0.8` still failed on CI runners
   * that were demonstrably running the tasks at once. A ratio taken from a wall
   * clock on shared hardware is a measurement of the neighbours.
   */
  test('genuinely runs two tasks at the same time', async () => {
    const cores = navigator.hardwareConcurrency ?? 1

    if (cores < 2) {
      console.log(`  skipping: ${cores} core, nothing to run in parallel on`)

      return
    }

    /**
     * Overlap, not speedup.
     *
     * This asserted `parallel < serial * 0.8` and was right about the intent and
     * wrong about the measurement: a wall clock on a shared CI runner measures
     * the neighbours as much as the work, and the ratio failed on runners that
     * were plainly running the tasks in parallel. Two intervals that overlap
     * cannot have come from one thread, whatever the machine was doing at the
     * time — and if the driver ever quietly fell back to running them one after
     * another, no amount of hardware would make them overlap.
     */
    const task = { module: fixtures, export: 'window', args: [40_000_000] }

    const [first, second] = (await new WorkerDriver(import.meta.dir).run([task, task])) as Array<{
      start: number
      end: number
    }>

    const overlap =
      Math.min(first?.end ?? 0, second?.end ?? 0) - Math.max(first?.start ?? 0, second?.start ?? 0)

    expect(overlap).toBeGreaterThan(0)

    // And the sync driver is the control: the same two tasks, strictly one after
    // the other, which is what makes the assertion above mean something.
    const [one, two] = (await new SyncDriver(import.meta.dir).run([task, task])) as Array<{
      start: number
      end: number
    }>

    expect((two?.start ?? 0) >= (one?.end ?? 0)).toBe(true)
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

  /**
   * The resolution itself, because the drivers can only prove it for this
   * platform.
   *
   * Both used to build `file://${base}/${module}` by hand and take `.pathname`
   * back off it. On Linux and macOS that round-trips; on Windows it produces
   * `/D:/app/x.ts`, a leading slash in front of a drive letter, and every task
   * on that platform failed to import — which is exactly the shape of bug that
   * only a run on the other operating system finds.
   */
  test('a specifier is a file URL, on every platform', () => {
    const specifier = specifierFor('./fixtures/tasks.ts', import.meta.dir)

    expect(specifier.startsWith('file://')).toBe(true)
    expect(specifier).toBe(pathToFileURL(fixtures).href)
    // And it round-trips back to the native path, which is what the broken
    // version could not do: `/D:/app/x.ts` is not a path on any platform.
    expect(fileURLToPath(specifier)).toBe(fixtures)

    // An absolute module is taken as it is, not re-resolved against the base.
    expect(specifierFor(fixtures, '/somewhere/else')).toBe(pathToFileURL(fixtures).href)
  })
})
