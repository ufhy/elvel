import { describe, expect, test } from 'bun:test'
import { DEFAULTS, findings, split } from '../src/bar/findings.ts'
import { type BarEntry, BatchRing } from '../src/bar/ring.ts'
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

  /** Different tables are a different query, and usually a different problem. */
  test('different statements are not grouped', () => {
    expect(
      judge([
        query('select * from posts'),
        query('select * from users'),
        query('select * from tags')
      ])
    ).toEqual([])
  })

  /**
   * The same loop, written without bindings.
   *
   * The builder binds its values, so a loop over ids is already one statement.
   * Raw SQL is not: `where id = 1` and `where id = 2` were filed as unrelated
   * queries, which is the N+1 nobody was told about.
   */
  test('statements differing only in a literal are one loop', () => {
    const found = judge([
      query('select * from comments where post_id = 1'),
      query('select * from comments where post_id = 2'),
      query('select * from comments where post_id = 3')
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.title).toBe('The same query ran 3 times')
    // The statement as it was written, not as it was grouped.
    expect(found[0]?.detail).toContain('post_id = 1')
  })

  /** A number inside a string is part of the string, not a literal of its own. */
  test('and a quoted value is replaced whole', () => {
    expect(
      judge([
        query("select * from users where name = 'user 1'"),
        query("select * from users where name = 'user 2'"),
        query("select * from users where name = 'user 3'")
      ])
    ).toHaveLength(1)
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

/**
 * The findings that read an entry type nothing read before.
 *
 * Each was a row on the checklist in issue #14: the data was recorded and
 * nothing looked at it, which is a list of forty rows where an answer belongs.
 */
describe('what else the entries already say', () => {
  const ids = (entries: BarEntry[]) => judge(entries).map((one) => one.id.split(':')[0])

  test('a 4xx or 5xx is a finding of its own', () => {
    expect(ids([entry('request', { responseStatus: 500 })])).toContain('status')
    expect(ids([entry('request', { responseStatus: 302, location: '/next' })])).not.toContain(
      'status'
    )
  })

  test('a route that matched nothing, when the entry says so', () => {
    expect(ids([entry('request', { responseStatus: 404, route: null })])).toContain('unrouted')
    // Absent rather than empty: an entry that records no route at all.
    expect(ids([entry('request', { responseStatus: 404 })])).not.toContain('unrouted')
  })

  test('a redirect with nowhere to go', () => {
    expect(ids([entry('request', { responseStatus: 302, location: null })])).toContain(
      'redirect-nowhere'
    )
    expect(ids([entry('request', { responseStatus: 302, location: '/next' })])).not.toContain(
      'redirect-nowhere'
    )
  })

  /** A GET is meant to be safe to repeat — a prefetch, a crawler, a retry. */
  test('a write statement on a GET', () => {
    const found = ids([
      entry('request', { method: 'GET', responseStatus: 200 }),
      query('update users set seen_at = ?')
    ])

    expect(found).toContain('write-on-get')

    expect(
      ids([
        entry('request', { method: 'POST', responseStatus: 200 }),
        query('update users set seen_at = ?')
      ])
    ).not.toContain('write-on-get')
  })

  test('the same exception class twice is a loop around it', () => {
    const twice = [
      entry('request', { responseStatus: 500 }),
      entry('exception', { class: 'TypeError', message: 'a' }),
      entry('exception', { class: 'TypeError', message: 'b' })
    ]

    expect(ids(twice)).toContain('repeated-exception')
  })

  test('a failed job, and one that needed a second attempt', () => {
    expect(ids([entry('job', { status: 'failed', name: 'SendInvoice', error: 'nope' })])).toContain(
      'failed-jobs'
    )

    expect(
      ids([entry('job', { status: 'processed', name: 'SendInvoice', attempts: 3 })])
    ).toContain('retried-jobs')
  })

  test('an outbound call that failed, and one made over and over', () => {
    expect(
      ids([entry('client_request', { uri: 'https://api/x', responseStatus: 503, failed: true })])
    ).toContain('failed-calls')

    const loop = Array.from({ length: 4 }, () =>
      entry('client_request', { uri: 'https://api/user', responseStatus: 200, duration: 20 })
    )

    expect(ids(loop)).toContain('repeated-call')
  })

  test('a denied gate, a non-zero command, mail with no recipient, a dump', () => {
    expect(ids([entry('gate', { ability: 'update', result: 'denied' })])).toContain('denied')
    expect(ids([entry('command', { command: 'migrate', exitCode: 1 })])).toContain(
      'failed-commands'
    )
    expect(ids([entry('mail', { subject: 'Hello', to: [], cc: [], bcc: [] })])).toContain(
      'mail-unaddressed'
    )
    expect(ids([entry('dump', { values: [{ text: 'x' }] })])).toContain('dumps')
  })

  test('and none of them fires on a request that did none of it', () => {
    expect(
      judge([
        entry('request', { method: 'GET', responseStatus: 200, route: '/articles' }),
        query('select * from articles', 2),
        entry('gate', { ability: 'view', result: 'allowed' }),
        entry('client_request', { uri: 'https://api/x', responseStatus: 200, duration: 5 }),
        entry('mail', { subject: 'Hi', to: ['ada@example.test'], cc: [], bcc: [] })
      ])
    ).toEqual([])
  })
})

/**
 * The second batch from issue #14, and the three that read the batch itself.
 *
 * Every threshold here is a judgement rather than a measurement, which is why
 * they all live in `Thresholds` — these tests pin the behaviour, not the number.
 */
describe('the rest of what a batch says', () => {
  const ids = (entries: BarEntry[], batch = {}) =>
    findings(entries, split(entries, 100), DEFAULTS, batch).map((one) => one.id.split(':')[0])

  test('a notification that failed, a task that failed, and one that overlapped', () => {
    expect(
      ids([entry('notification', { notification: 'Welcome', channel: 'mail', outcome: 'failed' })])
    ).toContain('failed-notifications')

    expect(ids([entry('schedule', { task: 'prune', outcome: 'failed' })])).toContain('failed-tasks')
    expect(ids([entry('schedule', { task: 'prune', outcome: 'overlapping' })])).toContain(
      'overlapping-tasks'
    )
    expect(ids([entry('schedule', { task: 'prune', outcome: 'ran' })])).toEqual([])
  })

  test('a log nobody could read, and a request full of events', () => {
    const lines = Array.from({ length: 20 }, () => entry('log', { level: 'info', message: 'x' }))
    const events = Array.from({ length: 30 }, () => entry('event', { name: 'order.placed' }))

    expect(ids(lines)).toContain('log-noise')
    expect(ids(events)).toContain('many-events')
    expect(ids(lines.slice(0, 5))).toEqual([])
  })

  test('a view that is huge, and one rendered in a loop', () => {
    expect(ids([entry('view', { view: 'Report', size: 600 * 1024, time: 5 })])).toContain(
      'heavy-view'
    )

    const loop = Array.from({ length: 15 }, () =>
      entry('view', { view: 'Row', size: 200, time: 1 })
    )

    expect(ids(loop)).toContain('repeated-view')
  })

  test('the same ability asked over and over', () => {
    const loop = Array.from({ length: 15 }, () =>
      entry('gate', { ability: 'view', result: 'allowed' })
    )

    expect(ids(loop)).toContain('repeated-gate')
  })

  test('a large outbound response, a large cached value, a cache that expires at once', () => {
    expect(
      ids([
        entry('client_request', {
          uri: 'https://api/x',
          responseStatus: 200,
          responseSize: 2 * 1024 * 1024
        })
      ])
    ).toContain('heavy-call')

    expect(
      ids([entry('cache', { type: 'set', key: 'report', value: 'x'.repeat(200 * 1024) })])
    ).toContain('heavy-cache')

    expect(ids([entry('cache', { type: 'set', key: 'token', expiration: 1 })])).toContain(
      'brief-cache'
    )
    // Forever is not brief.
    expect(ids([entry('cache', { type: 'set', key: 'token', expiration: 0 })])).toEqual([])
  })

  /** 400ms is fine for a report and alarming for a redirect. */
  test('slow for this route, which a fixed threshold cannot tell', () => {
    const verdict = { route: 'GET /articles', medianMs: 40, samples: 20, times: 3.2 }

    expect(ids([], { verdict })).toContain('slower-than-usual')
    expect(ids([], { verdict: { ...verdict, times: 1.1 } })).toEqual([])
    // No median yet, so nothing to be slower than.
    expect(ids([], { verdict: { route: 'GET /x', medianMs: 0, samples: 1 } })).toEqual([])
  })

  test('the time that went before the handler ever ran', () => {
    const entries = [entry('request', { responseStatus: 200, route: '/x', method: 'GET' })]
    const found = findings(entries, split(entries, 100), DEFAULTS, {
      marks: [
        { name: 'middleware', atMs: 5 },
        { name: 'handler', atMs: 80 }
      ]
    })

    expect(found.map((one) => one.id)).toContain('before-the-handler')
    expect(found.find((one) => one.id === 'before-the-handler')?.cost).toBe(80)
  })

  test('and a profile that is mostly not your code', () => {
    const profile = {
      durationMs: 100,
      outsideMs: 10,
      origins: [
        { name: 'elysia', selfMs: 60, mine: false },
        { name: 'better-auth', selfMs: 20, mine: false },
        { name: 'app/Http', selfMs: 20, mine: true }
      ]
    }

    expect(ids([], { profile })).toContain('framework-bound')

    expect(
      ids([], {
        profile: { ...profile, origins: [{ name: 'app/Http', selfMs: 90, mine: true }] }
      })
    ).toEqual([])
  })
})

describe('and the last of them', () => {
  const ids = (entries: BarEntry[]) =>
    findings(entries, split(entries, 100), DEFAULTS).map((one) => one.id.split(':')[0])

  test('a request body big enough to be worth saying', () => {
    expect(
      ids([entry('request', { responseStatus: 200, payload: { blob: 'x'.repeat(300 * 1024) } })])
    ).toContain('heavy-payload')
  })

  /** One key nothing writes is `missedTwice`; this is a store that is cold. */
  test('a cache that mostly misses', () => {
    const cold = Array.from({ length: 6 }, (_, index) =>
      entry('cache', { type: CACHE_MISSED, key: `k${index}` })
    )

    expect(ids(cold)).toContain('cache-cold')

    const warm = [
      ...Array.from({ length: 5 }, (_, index) => entry('cache', { type: 'hit', key: `k${index}` })),
      entry('cache', { type: CACHE_MISSED, key: 'k9' })
    ]

    expect(ids(warm)).not.toContain('cache-cold')
  })

  /** One transactional mail is ordinary; two is a loop or a fan-out. */
  test('mail sent while the caller waited, from two', () => {
    const request = entry('request', { responseStatus: 200, method: 'POST' })
    const mail = () => entry('mail', { subject: 'Hi', to: ['a@b.test'], attachments: 0 })

    expect(ids([request, mail()])).not.toContain('mail-in-request')
    expect(ids([request, mail(), mail()])).toContain('mail-in-request')
  })

  test('and a mail carrying a pile of attachments', () => {
    expect(
      ids([
        entry('request', { responseStatus: 200 }),
        entry('mail', { subject: 'Report', to: ['a@b.test'], attachments: 6 }),
        entry('mail', { subject: 'Report', to: ['c@d.test'], attachments: 6 })
      ])
    ).toContain('mail-attachments')
  })

  test('a batch whose jobs did not all arrive', () => {
    expect(
      ids([
        entry('batch', { batch: 'b1', name: 'Import', totalJobs: 40 }),
        entry('job', { status: 'failed', name: 'ImportRow', error: 'bad row' })
      ])
    ).toContain('failed-batch')
  })
})

/**
 * The numbers are arguable, so an application must be able to argue.
 *
 * A hundred milliseconds is a slow query in a request and an ordinary one in a
 * nightly report; the finding is the product, the number is a setting.
 */
describe('thresholds', () => {
  test('a raised bar stops a finding, a lowered one starts it', () => {
    const entries = [entry('request', { responseStatus: 200 }), query('select 1', 150)]
    const shape = split(entries, 400)

    const loud = findings(entries, shape, DEFAULTS).map((one) => one.id.split(':')[0])
    const quiet = findings(entries, shape, { ...DEFAULTS, slowQuery: 500 }).map(
      (one) => one.id.split(':')[0]
    )

    expect(loud).toContain('slow')
    expect(quiet).not.toContain('slow')
  })

  test('and the ring hands its own down to the analysis', () => {
    const ring = new BatchRing(5, 1024 * 1024, { ...DEFAULTS, logLines: 2 })

    ring.push({
      batchId: 'b1',
      at: Date.now(),
      method: 'GET',
      path: '/x',
      status: 200,
      durationMs: 10,
      kind: 'page',
      marks: [],
      entries: [
        entry('log', { level: 'info', message: 'one' }),
        entry('log', { level: 'info', message: 'two' })
      ]
    })

    expect(ring.get('b1')?.found.map((one) => one.id)).toContain('log-noise')
  })
})

/**
 * A transaction covers one connection, so two written in one request cannot be
 * rolled back together — whatever either of them was inside.
 */
describe('writes across connections', () => {
  const ids = (entries: BarEntry[]) =>
    findings(entries, split(entries, 100), DEFAULTS).map((one) => one.id.split(':')[0])

  test('two connections written is a finding', () => {
    expect(
      ids([
        query('insert into orders (id) values (?)', 2, { connection: 'mysql' }),
        query('insert into audit (id) values (?)', 2, { connection: 'reporting' })
      ])
    ).toContain('two-connections')
  })

  test('two connections merely read is not', () => {
    expect(
      ids([
        query('select * from orders', 2, { connection: 'mysql' }),
        query('select * from audit', 2, { connection: 'reporting' })
      ])
    ).not.toContain('two-connections')
  })

  test('and many writes to one connection is not either', () => {
    expect(
      ids([
        query('insert into orders (id) values (?)', 2, { connection: 'mysql' }),
        query('update orders set paid = ?', 2, { connection: 'mysql' })
      ])
    ).not.toContain('two-connections')
  })
})

/**
 * The four from the checklist that needed something recorded first.
 *
 * Each had been struck off as "needs data nothing records"; three of them
 * needed the recording, and the fourth needed a number somebody was willing to
 * argue for.
 */
describe('what needed recording first', () => {
  const judgeWith = (entries: BarEntry[], batch = {}) =>
    findings(entries, split(entries, 100), DEFAULTS, batch).map((one) => one.id)

  /**
   * Memory is not here, and that is the measurement rather than an omission.
   *
   * It was, for a day. `process.memoryUsage().heapUsed` reported the *same*
   * number across four consecutive playground requests — Bun's reading is far
   * coarser than one request — so the growth was 0 almost always. And a shared
   * heap cannot be attributed to a request anyway: a page that calls its own
   * server allocates in both windows at once. Hydration survived the same audit
   * because a request *causes* its hydrations and they can be counted per
   * context; bytes cannot.
   */
  test('a request that built a great many models', () => {
    const found = findings([query('select * from rows')], split([], 100), DEFAULTS, {
      hydrated: 4000
    })

    expect(found.map((one) => one.id)).toContain('many-models')
    expect(found.find((one) => one.id === 'many-models')?.title).toContain('4000 models')
    expect(judgeWith([], { hydrated: 12 })).not.toContain('many-models')
  })

  test('a job one failure from being dropped', () => {
    expect(
      judgeWith([entry('job', { name: 'Import', status: 'processed', attempts: 3, tries: 3 })])
    ).toContain('jobs-nearly-given-up')

    expect(
      judgeWith([entry('job', { name: 'Import', status: 'processed', attempts: 1, tries: 5 })])
    ).not.toContain('jobs-nearly-given-up')

    // A queue with no limit never runs out of attempts.
    expect(
      judgeWith([entry('job', { name: 'Import', status: 'processed', attempts: 9, tries: 0 })])
    ).not.toContain('jobs-nearly-given-up')
  })
})

/**
 * The finding the plan exists for.
 *
 * Present only when `lens.watchers.query.explain` is on, because asking costs a
 * statement. A slow query is a fact; a full scan is a cause.
 */
describe('a query that read the whole table', () => {
  const ids = (entries: BarEntry[]) =>
    findings(entries, split(entries, 100), DEFAULTS).map((one) => one.id)

  test('names the tables, not the symptom', () => {
    const found = findings(
      [query('select * from users where note = ?', 40, { scans: ['users'] })],
      split([], 100),
      DEFAULTS
    )

    const scan = found.find((one) => one.id === 'full-scan')

    expect(scan?.title).toContain('1 query reads a whole table')
    expect(scan?.detail).toContain('users')
    expect(scan?.cost).toBe(40)
  })

  test('and says nothing when nothing asked', () => {
    expect(ids([query('select * from users where note = ?', 40)])).not.toContain('full-scan')
    expect(ids([query('select * from users', 40, { scans: [] })])).not.toContain('full-scan')
  })
})
