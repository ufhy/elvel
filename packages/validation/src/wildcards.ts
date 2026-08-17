import { Arr } from '@elvel/support'
import type { Data } from './types.ts'

/**
 * Turn one wildcard rule key into the concrete attributes it covers.
 *
 * `items.*.price` against `{ items: [{ price: 1 }, {}] }` gives
 * `['items.0.price', 'items.1.price']` — including the second, whose value is
 * missing. That is the whole reason this walks the pattern rather than filtering
 * the flattened data: `required` on `items.*.price` has to fail for an element
 * that left the field out, and an attribute that does not exist cannot fail.
 *
 * `*` matches one segment. Anything after it is appended whether it is present or
 * not; `*` itself only produces what the data actually has, since there is no way
 * to know how many elements were meant.
 */
export function expandWildcard(data: Data, pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern]

  let paths: string[] = ['']

  for (const segment of pattern.split('.')) {
    const next: string[] = []

    for (const path of paths) {
      if (segment !== '*') {
        next.push(path === '' ? segment : `${path}.${segment}`)
        continue
      }

      for (const key of keysOf(path === '' ? data : Arr.get(data, path))) {
        next.push(path === '' ? key : `${path}.${key}`)
      }
    }

    paths = next
  }

  return paths
}

/**
 * The keys a `*` stands for: array indices, or an object's own keys.
 *
 * Anything else contributes nothing — `items.*.price` where `items` is a string
 * produces no attributes at all, and the rule on `items` itself (`array`) is what
 * reports that. Producing something here would report the same problem twice, in
 * the wrong place.
 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_entry, index) => String(index))

  if (value !== null && typeof value === 'object') return Object.keys(value)

  return []
}

/** True when `attribute` is one of the paths `pattern` covers. */
export function matchesPattern(pattern: string, attribute: string): boolean {
  const patternSegments = pattern.split('.')
  const attributeSegments = attribute.split('.')

  if (patternSegments.length !== attributeSegments.length) return false

  return patternSegments.every(
    (segment, index) => segment === '*' || segment === attributeSegments[index]
  )
}

/**
 * The values a `*` stood for, in order — `['0', 'orders']` for
 * `lines.0.orders.qty` under `lines.*.*.qty`.
 *
 * What `:index` and `:position` in a message are built from.
 */
export function explicitKeys(pattern: string, attribute: string): string[] {
  const patternSegments = pattern.split('.')
  const attributeSegments = attribute.split('.')

  const keys: string[] = []

  patternSegments.forEach((segment, index) => {
    if (segment === '*' && attributeSegments[index] !== undefined) {
      keys.push(attributeSegments[index] as string)
    }
  })

  return keys
}

/**
 * Every value under a pattern, keyed by its concrete attribute.
 *
 * `distinct` is what needs this: "no two prices repeat" is a question about the
 * siblings, and only the pattern knows who they are.
 */
export function valuesUnder(data: Data, pattern: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}

  for (const attribute of expandWildcard(data, pattern)) {
    if (!Arr.has(data, attribute)) continue

    values[attribute] = Arr.get(data, attribute)
  }

  return values
}
