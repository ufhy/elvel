import { Elysia } from 'elysia'

/**
 * Create a controller.
 *
 * A controller is an Elysia instance, not a class of static handlers — that is
 * the pattern Elysia's own docs prescribe, and the only one that keeps the
 * request context fully inferred inside handlers.
 *
 * The `name` is required because it drives Elysia's plugin deduplication: a
 * controller pulled in from two route files must register its routes once.
 *
 * ```ts
 * export default controller('page')
 *   .get('/', () => view('pages.landing'))
 * ```
 */
export function controller<const Prefix extends string = ''>(name: string, prefix?: Prefix) {
  return new Elysia({ name, prefix })
}

/**
 * Group routes without creating a named, deduplicated unit — the equivalent of
 * `Route::group([...])` for a handful of related routes inside one file.
 */
export function routeGroup<const Prefix extends string = ''>(prefix?: Prefix) {
  return new Elysia({ prefix })
}
