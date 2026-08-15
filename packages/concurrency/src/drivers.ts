import {
  type ConcurrencyDriver,
  entriesOf,
  isDescriptor,
  type RunOptions,
  shapeLike,
  type Task,
  TaskError,
  type TaskResult,
  type Tasks
} from './contracts.ts'
import { specifierFor } from './specifier.ts'

/** Shared `run()`: settle everything, then throw on the first failure. */
abstract class BaseDriver implements ConcurrencyDriver {
  abstract settle<T>(
    tasks: Tasks<T>,
    options?: RunOptions
  ): Promise<TaskResult<T>[] | Record<string, TaskResult<T>>>

  async run<T>(tasks: Tasks<T>, options?: RunOptions): Promise<T[] | Record<string, T>> {
    const settled = await this.settle(tasks, options)
    const keyed = (
      Array.isArray(settled)
        ? Object.fromEntries(settled.map((result, index) => [String(index), result]))
        : settled
    ) as Record<string, TaskResult<T>>

    /**
     * Failure is reported in declaration order, not completion order.
     *
     * Which of several failures you hear about should not depend on which
     * machine ran the test.
     */
    for (const [key, result] of entriesOf(tasks).map(([key]) => [key, keyed[key]] as const)) {
      if (result && !result.ok) throw result.error
      if (!result) throw new TaskError(`Task [${key}] produced no result.`, key)
    }

    return shapeLike(
      tasks,
      Object.fromEntries(
        Object.entries(keyed).map(([key, result]) => [key, (result as { value: T }).value])
      )
    )
  }
}

/**
 * Everything in this process, one after another — Laravel's `sync` driver.
 *
 * Not concurrent at all, and that is the point: it is what a test uses, and what
 * an environment without workers falls back to. Anything that behaves
 * differently here than under a real driver is relying on parallelism for
 * correctness, which is worth finding out.
 */
export class SyncDriver extends BaseDriver {
  /**
   * `basePath` matters even here.
   *
   * A bare `import()` resolves relative to *this file*, so the same descriptor
   * would mean different modules under `sync` and `worker` — switching driver
   * would change which code runs, which is the one thing a driver must never do.
   */
  constructor(private readonly basePath: string = process.cwd()) {
    super()
  }

  async settle<T>(
    tasks: Tasks<T>,
    options: RunOptions = {}
  ): Promise<TaskResult<T>[] | Record<string, TaskResult<T>>> {
    const results: Record<string, TaskResult<T>> = {}

    for (const [key, task] of entriesOf(tasks)) {
      results[key] = await this.one(key, task, options)
    }

    return shapeLike(tasks, results)
  }

  private async one<T>(key: string, task: Task<T>, options: RunOptions): Promise<TaskResult<T>> {
    try {
      if (isDescriptor(task)) {
        const module = (await import(specifierFor(task.module, this.basePath))) as Record<
          string,
          unknown
        >
        const fn = module[task.export ?? 'default']

        if (typeof fn !== 'function') {
          throw new Error(`[${task.module}] has no callable export [${task.export ?? 'default'}].`)
        }

        return {
          ok: true,
          value: (await (fn as (...args: unknown[]) => T)(...(task.args ?? []))) as T
        }
      }

      const value = options.timeout
        ? await withTimeout(Promise.resolve(task()), options.timeout, key)
        : await task()

      return { ok: true, value: value as T }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: error instanceof TimeoutError
      }
    }
  }
}

class TimeoutError extends Error {}

/**
 * A timeout that does not stop the work.
 *
 * There is no way to abort an async function already running, so the sync
 * driver's timeout bounds *the wait* and nothing else — the task carries on in
 * the background. The worker driver can do better because it has a thread to
 * terminate, and it does.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`Task [${key}] did not finish within ${ms}ms.`)),
          ms
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type WorkerAnswer =
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string; name: string }

/**
 * One worker per task, in parallel — real use of more than one core.
 *
 * This is what `Promise.all` cannot do. `Promise.all` interleaves waiting, so it
 * is the right answer for anything I/O-bound and no answer at all for work that
 * is actually computing: two CPU-bound promises on one thread take exactly as
 * long as running them one after another.
 *
 * A worker is expensive to start — tens of milliseconds — so this is for tasks
 * big enough not to notice. Below that threshold, `sync` is faster and the
 * comparison is worth measuring rather than assuming.
 *
 * **Only descriptors.** A function is refused here, unlike Laravel, which
 * serialises a closure with its bound scope — PHP can do that and JavaScript
 * cannot. `Function.prototype.toString()` gives the body without the scope, and
 * Bun makes it worse than merely lossy: it inlines a captured `const` primitive
 * into the source, so `const name = 'ada'` arrives and `let name = 'ada'` does
 * not. A feature whose success depends on which keyword declared a variable is a
 * trap, so it is an error instead of a caveat.
 */
export class WorkerDriver extends BaseDriver {
  constructor(
    private readonly basePath: string = process.cwd(),
    private readonly entry: URL = new URL('./worker-entry.ts', import.meta.url)
  ) {
    super()
  }

  async settle<T>(
    tasks: Tasks<T>,
    options: RunOptions = {}
  ): Promise<TaskResult<T>[] | Record<string, TaskResult<T>>> {
    const entries = entriesOf(tasks)

    const settled = await Promise.all(entries.map(([key, task]) => this.one<T>(key, task, options)))

    return shapeLike(
      tasks,
      Object.fromEntries(entries.map(([key], index) => [key, settled[index] as TaskResult<T>]))
    )
  }

  private one<T>(key: string, task: Task<T>, options: RunOptions): Promise<TaskResult<T>> {
    return new Promise<TaskResult<T>>((resolve) => {
      const worker = new Worker(this.entry.href, { type: 'module' })
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (result: TaskResult<T>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        // Terminated, not left to exit: a task stuck in a loop would otherwise
        // hold a thread for the life of the process.
        worker.terminate()
        resolve(result)
      }

      worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
        const answer = event.data

        finish(
          answer.ok
            ? { ok: true, value: answer.value as T }
            : {
                ok: false,
                error: new TaskError(answer.message, key, answer.stack),
                timedOut: false
              }
        )
      }

      worker.onerror = (event: ErrorEvent) => {
        finish({
          ok: false,
          error: new TaskError(event.message || 'The worker failed to start.', key),
          timedOut: false
        })
      }

      if (options.timeout) {
        timer = setTimeout(
          () =>
            finish({
              ok: false,
              error: new TaskError(
                `Task [${key}] did not finish within ${options.timeout}ms.`,
                key
              ),
              timedOut: true
            }),
          options.timeout
        )
      }

      if (!isDescriptor(task)) {
        finish({
          ok: false,
          error: new TaskError(
            `Task [${key}] is a function, and a function cannot cross into a worker. ` +
              `Its closure does not travel, and Bun inlines a captured const primitive into ` +
              `the source, so whether the value arrives depends on whether it was declared ` +
              `const or let. Use { module, export, args } instead — the worker imports the ` +
              `code itself and args are cloned.`,
            key
          ),
          timedOut: false
        })

        return
      }

      worker.postMessage({
        base: this.basePath,
        module: task.module,
        export: task.export ?? 'default',
        args: task.args ?? []
      })
    })
  }
}
