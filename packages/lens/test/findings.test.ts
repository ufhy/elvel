import { describe, expect, test } from 'bun:test'
import { findings, split } from '../src/bar/findings.ts'
import type { BarEntry } from '../src/bar/ring.ts'
import { CACHE_MISSED } from '../src/watchers/cache.ts'

function entry(
  type: string,
  content: Record<string, unknown>,
  uuid = crypto.randomUUID()
): BarEntry {
  return {
    uuid,
    type,
    offsetMs: 0,
    tags: [],
    summary: { title: '', short: '', sub: '', slow: false },
    repeats: 1,
    content
  }
}

const query = (sql: string, time = 1, extra: Record<string, unknown> = {}) =>
  entry('query', { sql, time, ...extra })

function judge(entries: BarEntry[], totalMs = 100) {
  return findings(entries, split(entries, totalMs))
}

describe('where the time went', () => {
  test('the split is three numbers and they account for the whole', () => {
    const shape = split([query('select 1', 30), entry('view', { view: 'Page', time: 20 })], 100)

    expect(shape).toEqual({
      totalMs: 100,
      databaseMs: 30,
      renderMs: 20,
      otherMs: 50,
      queries: 1
    })
  })

  /**
   * A request whose entries claim more time than the request took — clock skew,
   * a query started before the batch opened — must not report negative work.
   */
  test('nothing is ever negative', () => {
    expect(split([query('select 1', 500)], 10).otherMs).toBe(0)
  })
})

describe('the N+1, named rather than badged', () => {
  test('the same statement three times is a finding with its caller', () => {
    const entries = [
      query('select * from users where id = ?', 2, { file: '/app/List.tsx', line: 22 }),
      query('select * from users where id = ?', 2, { file: '/app/List.tsx', line: 22 }),
      query('select * from users where id = ?', 3, { file: '/app/List.tsx', line: 22 })
    ]

    const [found] = judge(entries)

    expect(found?.level).toBe('problem')
    expect(found?.title).toBe('The same query ran 3 times')
    expect(found?.detail).toContain('/app/List.tsx:22')
    expect(found?.cost).toBe(7)
    expect(found?.evidence).toHaveLength(3)
  })

  test('twice is not a loop', () => {
    expect(judge([query('select 1'), query('select 1')])).toEqual([])
  })

  /**
   * The key is the statement with its placeholders still in it, which is the
   * recorder's own family hash made visible. Differing ids are the same query.
   */
  test('different statements are not grouped', () => {
    expect(judge([query('select 1'), query('select 2'), query('select 3')])).toEqual([])
  })
})

describe('slow work', () => {
  test('one slow query is called out on its own', () => {
    const [found] = judge([query('select * from big', 240)])

    expect(found?.title).toBe('A query took 240ms')
    expect(found?.cost).toBe(240)
  })

  /**
   * Said only when no single query is to blame. A bar that repeats itself is a
   * bar people stop reading.
   */
  test('database-bound is not reported when a slow query already explains it', () => {
    const found = judge([query('a', 120), query('b', 5)], 150)

    expect(found.map((one) => one.id.split(':')[0])).toEqual(['slow'])
  })

  test('database-bound is reported when no single query stands out', () => {
    const found = judge([query('a', 30), query('b', 30), query('c', 20)], 100)

    expect(found.some((one) => one.id === 'database-bound')).toBe(true)
    expect(found.find((one) => one.id === 'database-bound')?.title).toBe(
      '80% of this request was the database'
    )
  })
})

describe('things a list of entries would never tell you', () => {
  /**
   * The most valuable finding here: something threw, something caught it, and
   * the page came back 200. Invisible in the browser and invisible in the log if
   * nobody looked.
   */
  test('an exception that never reached the client', () => {
    const found = judge([
      entry('request', { responseStatus: 200 }),
      entry('exception', { class: 'TypeError', message: 'x is not a function' })
    ])

    expect(found[0]?.level).toBe('problem')
    expect(found[0]?.title).toBe('1 exception thrown, and the page still answered 200')
    expect(found[0]?.detail).toContain('x is not a function')
  })

  test('an exception that did reach the client is not a surprise', () => {
    const found = judge([
      entry('request', { responseStatus: 500 }),
      entry('exception', { class: 'TypeError', message: 'boom' })
    ])

    expect(found.some((one) => one.id === 'swallowed')).toBe(false)
  })

  /**
   * Written against the watcher's own constant, not a string typed from memory.
   * The first version of this check looked for `miss` while the watcher writes
   * `missed`, so it never fired once — and a test with the same typo in it would
   * have passed forever.
   */
  test('a cache key looked up twice and never found', () => {
    const found = judge([
      entry('cache', { type: CACHE_MISSED, key: 'user:1' }),
      entry('cache', { type: CACHE_MISSED, key: 'user:1' }),
      entry('cache', { type: CACHE_MISSED, key: 'user:2' })
    ])

    expect(found.map((one) => one.title)).toEqual(['Cache key user:1 missed 2 times'])
  })

  test('error-level log messages', () => {
    const found = judge([entry('log', { level: 'error', message: 'payment declined' })])

    expect(found[0]?.title).toBe('1 error-level log message')
  })

  test('a response nobody wants to download', () => {
    const found = judge([entry('request', { responseStatus: 200, response: 'x'.repeat(300_000) })])

    expect(found[0]?.title).toBe('The response was 293 KB')
  })
})

describe('a clean request', () => {
  /**
   * The finding list must be empty for ordinary work, or the bar cries wolf and
   * the red dot stops meaning anything.
   */
  test('says nothing at all', () => {
    const found = judge(
      [
        entry('request', { responseStatus: 200, response: 'ok' }),
        query('select * from users where id = ?', 2),
        entry('view', { view: 'Page', time: 4, size: 900 })
      ],
      40
    )

    expect(found).toEqual([])
  })
})

describe('order', () => {
  test('what costs the most is first, and what has no cost is last', () => {
    const found = judge([
      entry('request', { responseStatus: 200 }),
      entry('exception', { class: 'E', message: 'quiet' }),
      query('slow one', 300)
    ])

    expect(found.map((one) => one.id.split(':')[0])).toEqual(['slow', 'swallowed'])
  })
})
