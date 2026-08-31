import { describe, expect, test } from 'bun:test'
import { resolveStacks } from '../src/stacks.ts'

/**
 * Two questions asked of a rendered page on every render, and both used to read
 * the whole thing.
 *
 * The doctype check ran `markup.trimStart().toLowerCase()` to look at five
 * characters — two copies of the document, 26µs on a 50KB page. The stack resolver
 * built a regex and scanned for a marker most pages do not contain.
 */
describe('the doctype check', () => {
  const opens = /^\s*<html/i

  test('recognises a page that starts with html', () => {
    expect<boolean>(opens.test('<html><body></body></html>')).toBe(true)
    expect<boolean>(opens.test('<HTML lang="id">')).toBe(true)
  })

  /**
   * The first attempt read a fixed-length slice, and a page with forty characters
   * of leading whitespace lost its doctype because the slice ended before the
   * markup began.
   */
  test('and one that starts with a lot of whitespace', () => {
    expect<boolean>(opens.test(`${' '.repeat(40)}<html>`)).toBe(true)
    expect<boolean>(opens.test(`\n\n\t  <html>`)).toBe(true)
  })

  test('but not a fragment', () => {
    expect<boolean>(opens.test('<div>partial</div>')).toBe(false)
    expect<boolean>(opens.test('text then <html>')).toBe(false)
    expect<boolean>(opens.test('')).toBe(false)
  })
})

describe('resolving stacks', () => {
  /** Outside a render there is no store, so the page is returned untouched. */
  test('leaves a page with no markers exactly as it was', () => {
    const page = `<html><body>${'<p>x</p>'.repeat(100)}</body></html>`

    expect<string>(resolveStacks(page)).toBe(page)
  })

  test('and does not mistake similar-looking markup for a marker', () => {
    const page = '<!-- elvel:stack: not really --><div>ok</div>'

    expect<string>(resolveStacks(page)).toBe(page)
  })
})
