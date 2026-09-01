import { describe, expect, test } from 'bun:test'
import { requestPath, requestSearch, requestTarget } from '../src/request-path.ts'

/**
 * Asserted **against `URL`**, not against a hand-written expectation.
 *
 * The whole reason this helper is allowed to exist is that it agrees with the
 * thing it replaces. A fixture saying `'/build/../.env'` should give `'/.env'`
 * would pass whether or not that is what `URL` does; comparing the two says the
 * substitution is safe, which is the actual claim.
 *
 * The traversal cases matter most. `@elvel/vite`'s build guard compares the path
 * against a `/build/` prefix and its comment records why it needs no traversal
 * check of its own — `/build/../.env` never matches the prefix, because it has
 * already been normalised. That normalisation happens in the `Request`
 * constructor, not in `URL.pathname`, and these tests are what pin it down.
 */
const urls = [
  'http://host/plain',
  'http://host/api/users/42',
  // Traversal, plain and percent-encoded: normalised before anything sees it.
  'http://host/build/../.env',
  'http://host/%2e%2e/secret',
  'http://host/a/./b',
  'http://host/a/../../b',
  // Shapes that have surprised a hand-rolled parser before.
  'http://host',
  'http://host/',
  'http://host?a=1',
  'http://host#frag',
  'http://host/a//b',
  'http://host/x?a=1&b=2',
  'http://host/x#frag',
  'http://host/x?a=1#frag',
  'http://host/ruang%20nama',
  'http://host/emoji/%F0%9F%A6%8A',
  'https://host:8080/p?q',
  'http://user:pass@host/p',
  'http://host/trailing/',
  'http://host/build/assets/index-abc123.js'
]

describe('requestPath', () => {
  for (const url of urls) {
    test(`agrees with URL.pathname for ${url}`, () => {
      const request = new Request(url)

      expect(requestPath(request)).toBe(new URL(request.url).pathname)
    })
  }
})

describe('requestSearch', () => {
  for (const url of urls) {
    test(`agrees with URL.search for ${url}`, () => {
      const request = new Request(url)

      expect(requestSearch(request)).toBe(new URL(request.url).search)
    })
  }
})

describe('requestTarget', () => {
  test('is the path and the query, and nothing else', () => {
    const request = new Request('http://host/x?a=1#frag')

    expect(requestTarget(request)).toBe('/x?a=1')
  })

  for (const url of urls) {
    test(`agrees with URL for ${url}`, () => {
      const request = new Request(url)
      const parsed = new URL(request.url)

      expect(requestTarget(request)).toBe(parsed.pathname + parsed.search)
    })
  }
})

/**
 * A path with no query is the common case, and it must not allocate a query.
 *
 * `URL.search` is `''` rather than `'?'` when there is none, and a caller
 * concatenating the two would otherwise produce `/x?` — which is a different
 * path to a router that compares strings.
 */
test('an absent query is empty, not a bare question mark', () => {
  expect(requestSearch(new Request('http://host/x'))).toBe('')
  expect(requestTarget(new Request('http://host/x'))).toBe('/x')
})
