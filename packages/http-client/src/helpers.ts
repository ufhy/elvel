import { app } from '@elysian/core'
import type { HttpClient } from './factory.ts'

/**
 * The HTTP client — Laravel's `Http` facade.
 *
 * ```ts
 * const response = await http().acceptJson().get('https://api.example.com/users')
 * const users = response.throw().json<User[]>()
 * ```
 */
export function http(): HttpClient {
  return app('http.client')
}
