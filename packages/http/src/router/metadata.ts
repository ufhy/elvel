/**
 * Arbitrary values attached to a route — Laravel 13's `Route::metadata`.
 *
 * What it is for: the things a *page* knows about itself and a layout needs, with
 * nowhere else to live. A title, a `robots` directive, which section of the
 * navigation is current. Threading those through props from the handler to a
 * component three levels down is the plumbing that makes people hard-code them
 * instead.
 *
 * The merge rules are `Illuminate\Routing\RouteGroup::mergeMetadata`, and they are
 * not obvious, so they are reproduced from the six tests in `RouteRegistrarTest`
 * rather than from a reading of the code:
 *
 * - a route's metadata merges **over** its group's, key by key
 * - two plain objects at the same key merge **deeply**
 * - a **list** replaces a list: `robots: ['index']` under `robots: ['noindex']`
 *   leaves `['noindex']`, not four entries
 * - an **empty** object replaces rather than merges, so a group's value can be
 *   cleared
 */
export type Metadata = Record<string, unknown>

/**
 * `new` over `old`, deeply where both sides are objects with something in them.
 *
 * The emptiness condition is where this departs from the PHP line by line, and it
 * has to: `mergableMetadata` asks `Arr::isAssoc()`, and in PHP an empty array is
 * not associative — which is what makes `metadata({ head: {} })` *clear* the
 * group's `head` rather than inherit it. `{}` in JavaScript is unambiguously an
 * object, so copying the condition would inherit instead, and
 * `testEmptyRouteMetadataArrayReplacesParentValue` is the test that says which
 * behaviour is the contract.
 */
export function mergeMetadata(old: Metadata, next: Metadata): Metadata {
  const merged: Metadata = { ...old }

  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key]

    merged[key] =
      mergeable(existing) && mergeable(value)
        ? mergeMetadata(existing as Metadata, value as Metadata)
        : value
  }

  return merged
}

/**
 * One value out of the tree, by a dotted path — Laravel's `Arr::get`.
 *
 * `getMetadata()` answers everything, `getMetadata('head')` a branch, and
 * `getMetadata('head.title')` a leaf. The dotted form is the one worth having: a
 * layout asking for `head.title` should not have to know whether `head` was set.
 */
export function metadataAt(metadata: Metadata, key?: string, fallback?: unknown): unknown {
  if (key === undefined) return metadata

  let found: unknown = metadata

  for (const step of key.split('.')) {
    if (typeof found !== 'object' || found === null || Array.isArray(found)) return fallback

    if (!(step in (found as Metadata))) return fallback

    found = (found as Metadata)[step]
  }

  return found === undefined ? fallback : found
}

/** A plain object with something in it — never an array, never empty. */
function mergeable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length > 0
  )
}
