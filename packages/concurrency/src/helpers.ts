import { app } from '@elysian/core'
import type { ConcurrencyManager } from './manager.ts'

/**
 * The concurrency manager — Laravel's `Concurrency` facade.
 *
 * ```ts
 * const [a, b] = await concurrency().run([
 *   { module: './app/Reports/monthly.ts', export: 'build', args: [2026, 7] },
 *   { module: './app/Reports/monthly.ts', export: 'build', args: [2026, 8] }
 * ])
 * ```
 */
export function concurrency(): ConcurrencyManager {
  return app('concurrency')
}
