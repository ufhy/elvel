import { app } from '@elvel/core'
import type { RouteRegistry } from './routes.ts'

/** The route name table. */
export function routes(): RouteRegistry {
  return app('routes')
}

/**
 * The URL for a named route — Laravel's `route()`.
 *
 * ```ts
 * route('articles.show', { id: article.id })   // /articles/12
 * route('articles.index', { page: 2 })         // /articles?page=2
 * route('articles.show', { id: 12 }, true)     // https://example.com/articles/12
 * ```
 *
 * Relative by default, where Laravel is absolute. A relative URL is right for a
 * link in a page and cannot point at the wrong host when the application is
 * behind a proxy; `absolute` is there for a mail, where a relative link is
 * useless.
 */
export function route(
  name: string,
  parameters: Record<string, unknown> = {},
  absolute = false
): string {
  return routes().to(name, parameters, absolute)
}
