import { app } from '@elyvel/core'
import type { Schedule } from './schedule.ts'

/**
 * The application's schedule.
 *
 * ```ts
 * schedule().command('cache:prune').daily()
 * schedule().call(() => sweep()).everyFifteenMinutes().withoutOverlapping()
 * ```
 */
export function schedule(): Schedule {
  return app('schedule')
}
