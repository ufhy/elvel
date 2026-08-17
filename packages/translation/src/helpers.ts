import { app } from '@elvel/core'
import type { Translator } from './translator.ts'

/** The translator. */
export function trans(): Translator {
  return app('translator')
}

/**
 * A translated message — Laravel's `__()`.
 *
 * ```tsx
 * <h1 safe>{__('orders.title')}</h1>
 * <p safe>{__('orders.greeting', { name: user.name })}</p>
 * ```
 */
export function __(key: string, replace: Record<string, unknown> = {}, locale?: string): string {
  return trans().get(key, replace, locale)
}

/** A message chosen by count — `choice('orders.count', orders.length)`. */
export function choice(
  key: string,
  count: number,
  replace: Record<string, unknown> = {},
  locale?: string
): string {
  return trans().choice(key, count, replace, locale)
}
