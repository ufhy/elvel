/**
 * Concurrency — work on more than one core.
 *
 * `Promise.all` already covers everything I/O-bound, which is most of what a web
 * application waits for, and covers nothing that is actually computing: two
 * CPU-bound promises on one thread take as long as running them in sequence.
 * This is for the other case.
 *
 * The cost is the boundary. A task crossing into a worker cannot bring its
 * closure — `toString()` carries the body and not the scope — so the honest form
 * is `{ module, export, args }`, where the child imports the code itself.
 */
export {
  type ConcurrencyDriver,
  entriesOf,
  isDescriptor,
  type RunOptions,
  shapeLike,
  type Task,
  type TaskDescriptor,
  TaskError,
  type TaskResult,
  type Tasks
} from './contracts.ts'
export { SyncDriver, WorkerDriver } from './drivers.ts'
export { concurrency } from './helpers.ts'
export { ConcurrencyManager, type DriverFactory } from './manager.ts'
export { ConcurrencyServiceProvider } from './provider.ts'
