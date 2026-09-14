import { app } from '@elvel/core'
import type { RedisConnection } from './connection.ts'
import type { RedisManager } from './manager.ts'

/**
 * The Redis manager.
 *
 * ```ts
 * await redis().send('ZADD', ['leaderboard', '10', 'ada'])
 * ```
 */
export function redis(): RedisManager {
  return app('redis')
}

/** A named connection — `connection('sessions')`. */
export function connection(name?: string): RedisConnection {
  return redis().connection(name)
}
