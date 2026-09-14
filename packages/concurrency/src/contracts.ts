/**
 * A task named by where it lives — the form that survives a boundary.
 *
 * ```ts
 * { module: './app/Reports/monthly.ts', export: 'build', args: [2026, 8] }
 * ```
 *
 * Preferred over a function for the `worker` and `process` drivers, because it
 * is the only form that cannot silently lose anything: the child imports the
 * module itself, so the code runs in a scope it actually has.
 */
export type TaskDescriptor = {
  /** Resolved from the application's base path, or absolute. */
  module: string
  /** Named export to call. `default` when omitted. */
  export?: string
  /** Passed to it. Must survive `structuredClone`. */
  args?: unknown[]
}

/**
 * A task is a module and an export, on every driver.
 *
 * A function was accepted under `sync` and refused under `worker`, so a task
 * written and tested against the fallback driver stopped working the moment the
 * real one ran it — which is the failure `sync` exists to prevent. A caller who
 * wants to run a local closure has `await fn()`; this is for work that has to be
 * nameable because it may not run here.
 */
// biome-ignore lint/correctness/noUnusedVariables: T documents the result type at the call site.
export type Task<T = unknown> = TaskDescriptor

/**
 * Why a function is refused, wherever it is passed.
 *
 * Said the same way by both drivers on purpose: `sync` used to accept one, so a
 * task proved under the fallback driver failed under the real one — and the
 * reason it fails is worth carrying to the caller who reached for the fallback.
 */
export function functionTaskMessage(key: string): string {
  return (
    `Task [${key}] is a function, and a function cannot cross into a worker. ` +
    `Its closure does not travel, and Bun inlines a captured const primitive into ` +
    `the source, so whether the value arrives depends on whether it was declared ` +
    `const or let. Use { module, export, args } instead — the worker imports the ` +
    `code itself and args are cloned. Refused under every driver, so that a task ` +
    `proved under sync is one worker can run.`
  )
}

/** Tasks given as a list keep their order; given as a record, their keys. */
export type Tasks<T = unknown> = Array<Task<T>> | Record<string, Task<T>>

export type RunOptions = {
  /** Milliseconds before a task is abandoned. */
  timeout?: number
}

/**
 * One task's outcome.
 *
 * Every task is reported, including the ones that failed — the point of running
 * ten things at once is usually to find out about all ten, and a rejected
 * `Promise.all` tells you about the first.
 */
export type TaskResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: Error; timedOut: boolean }

export interface ConcurrencyDriver {
  /** Run them, and hand back every outcome in the shape they were given. */
  settle<T>(
    tasks: Tasks<T>,
    options?: RunOptions
  ): Promise<TaskResult<T>[] | Record<string, TaskResult<T>>>
  /** Run them, throwing on the first failure. */
  run<T>(tasks: Tasks<T>, options?: RunOptions): Promise<T[] | Record<string, T>>
}

/**
 * Is this a descriptor rather than a function?
 *
 * The type says it must be, and this is what holds the line for a caller
 * without types — a JavaScript application, or one that cast.
 */
export function isDescriptor(task: unknown): task is TaskDescriptor {
  return (
    typeof task === 'object' && task !== null && typeof (task as TaskDescriptor).module === 'string'
  )
}

/** Tasks as `[key, task]` pairs, so a driver need not care which shape it got. */
export function entriesOf<T>(tasks: Tasks<T>): Array<[string, Task<T>]> {
  return Array.isArray(tasks)
    ? tasks.map((task, index) => [String(index), task])
    : Object.entries(tasks)
}

/** Put results back into the shape the tasks arrived in. */
export function shapeLike<T, R>(
  tasks: Tasks<T>,
  keyed: Record<string, R>
): R[] | Record<string, R> {
  if (!Array.isArray(tasks)) return keyed

  return tasks.map((_task, index) => keyed[String(index)] as R)
}

/**
 * A failure that came from a child.
 *
 * Carries the child's stack as text, since an `Error` cannot cross the boundary
 * intact and a message without a stack is most of the debugging cost.
 */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly remoteStack?: string
  ) {
    super(message)
    this.name = 'TaskError'
    if (remoteStack) this.stack = `${this.name}: ${message}\n${remoteStack}`
  }
}
