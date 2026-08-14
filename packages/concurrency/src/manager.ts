import type { ApplicationContract } from '@elysian/contracts'
import { defer } from '@elysian/core'
import type { ConcurrencyDriver, RunOptions, TaskResult, Tasks } from './contracts.ts'
import { SyncDriver, WorkerDriver } from './drivers.ts'

export type DriverFactory = () => ConcurrencyDriver

/**
 * Resolves drivers and forwards to the default — Laravel's `ConcurrencyManager`.
 *
 * Laravel ships `fork`, `process` and `sync`. `fork` exists because PHP cannot
 * await and is unusable in a web request; neither constraint applies here, so
 * this ships `worker` and `sync`. `worker` is the one that buys something
 * `Promise.all` cannot: another core.
 */
export class ConcurrencyManager {
  private readonly drivers = new Map<string, ConcurrencyDriver>()
  private readonly custom = new Map<string, DriverFactory>()

  constructor(private readonly app?: ApplicationContract) {}

  driver(name?: string): ConcurrencyDriver {
    const resolved =
      name ?? this.app?.config.get<string>('concurrency.driver', 'worker') ?? 'worker'

    const cached = this.drivers.get(resolved)
    if (cached) return cached

    const built = this.build(resolved)
    this.drivers.set(resolved, built)

    return built
  }

  extend(name: string, factory: DriverFactory): this {
    this.custom.set(name, factory)
    this.drivers.delete(name)

    return this
  }

  private build(name: string): ConcurrencyDriver {
    const custom = this.custom.get(name)
    if (custom) return custom()

    switch (name) {
      case 'worker':
        return new WorkerDriver(this.app?.basePath() ?? process.cwd())

      case 'sync':
        return new SyncDriver(this.app?.basePath() ?? process.cwd())

      default:
        throw new Error(
          `Concurrency driver [${name}] is not supported. Register it with concurrency().extend().`
        )
    }
  }

  /** Run them all, throwing on the first failure in declaration order. */
  run<T>(tasks: Tasks<T>, options?: RunOptions): Promise<T[] | Record<string, T>> {
    return this.driver().run(tasks, options)
  }

  /** Run them all and report every outcome, failures included. */
  settle<T>(
    tasks: Tasks<T>,
    options?: RunOptions
  ): Promise<TaskResult<T>[] | Record<string, TaskResult<T>>> {
    return this.driver().settle(tasks, options)
  }

  /**
   * Run them after the response has been sent.
   *
   * Uses the framework's own `defer()`, so the work is flushed by the same hook
   * and is equally not durable: a process that dies before the flush loses it.
   */
  defer<T>(tasks: Tasks<T>, options?: RunOptions): void {
    defer(() => this.settle(tasks, options))
  }
}
