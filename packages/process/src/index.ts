/**
 * Process — running a command, with something to assert against.
 *
 * `Bun.spawn` is already good: it kills on a timeout in the kernel and reports
 * the signal. What it does not give you is a result object, a pool, a pipe, or a
 * way to test code that spawns without spawning. That is what this adds.
 */
export { type FakeDefinition, ProcessManager } from './factory.ts'
export { process } from './helpers.ts'
export { InvokedProcess } from './invoked.ts'
export {
  type Command,
  type FakeHandler,
  type OutputHandler,
  PendingProcess,
  type ProcessOptions
} from './pending.ts'
export { type Builder, Pipe, Pool, PoolResults } from './pool.ts'
export { ProcessServiceProvider } from './provider.ts'
export { ProcessFailedError, ProcessResult } from './result.ts'
