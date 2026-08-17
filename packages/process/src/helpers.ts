import { app } from '@elyvel/core'
import type { ProcessManager } from './factory.ts'

/**
 * The process manager.
 *
 * ```ts
 * const result = await process().run(['git', 'rev-parse', 'HEAD'])
 * ```
 *
 * Named `process()` to match Laravel's facade, which shadows nothing here:
 * Node's global is `globalThis.process`, and a local function of the same name
 * is exactly what a module importing this one wants.
 */
export function process(): ProcessManager {
  return app('process')
}
