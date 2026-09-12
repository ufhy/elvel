import { expect, describe as group, test } from 'bun:test'
import { EntryType, entryTypes } from '../src/entry-type.ts'
import { describe, summarise, withoutPreview } from '../src/panels/describe.ts'

group('every type has a detail', () => {
  /**
   * `redis` is the one entry type with no watcher — Elvel has no Redis package —
   * so it is the one type with nothing to describe.
   */
  test('each type but redis produces at least one panel', () => {
    const content: Record<string, Record<string, unknown>> = {
      request: { method: 'GET', uri: '/' },
      query: { sql: 'select 1' },
      exception: { class: 'TypeError', message: 'broke' },
      log: { level: 'error', message: 'oh' },
      cache: { type: 'hit', key: 'k' },
      gate: { ability: 'view', result: 'allowed' },
      model: { action: 'created', model: 'User' },
      job: { name: 'SendInvoice', status: 'processed' },
      batch: { name: 'Nightly', totalJobs: 3 },
      schedule: { task: 'cache:prune', outcome: 'ran' },
      mail: { subject: 'Hello', to: ['a@b.c'] },
      notification: { notification: 'Welcome', channel: 'mail' },
      event: { name: 'user.created' },
      command: { command: 'migrate', exitCode: 0 },
      client_request: { method: 'GET', uri: 'https://x/y' },
      view: { view: 'Landing', size: 12 },
      dump: { values: [{ text: 'hello' }] },
      redis: {}
    }

    for (const type of entryTypes()) {
      const panels = describe(type, content[type] ?? {})

      if (type === 'redis') {
        expect(panels).toEqual([])

        continue
      }

      expect(panels.length).toBeGreaterThan(0)
    }
  })

  test('a panel with nothing in it is not produced at all', () => {
    const panels = describe(EntryType.REQUEST, { method: 'GET', uri: '/', headers: {} })

    expect(panels.map((panel) => panel.kind)).toEqual(['facts'])
  })

  /**
   * A query with nothing but its SQL has no connection, no duration and no
   * caller, so every row of its facts panel is empty and the panel itself goes.
   * The dashboard used to decide this inside each component; deciding it here is
   * what lets the bar be a plain renderer.
   */
  test('a facts panel whose every row is empty is not produced', () => {
    expect(describe(EntryType.QUERY, { sql: 'select 1' }).map((panel) => panel.kind)).toEqual([
      'code'
    ])
  })

  test('the rows that do have values are kept, in order', () => {
    const [facts] = describe(EntryType.QUERY, { sql: 'select 1', connection: 'pg', time: 4 })

    expect(facts?.kind === 'facts' && facts.rows).toEqual([
      ['Connection', 'pg'],
      ['Duration', '4ms']
    ])
  })
})

group('the mail preview never reaches a page we do not own', () => {
  test('the dashboard gets it', () => {
    const panels = describe(EntryType.MAIL, { subject: 'Hi', html: '<b>hello</b>' })

    expect(panels.some((panel) => panel.kind === 'preview')).toBe(true)
  })

  /**
   * On the dashboard a mail body is sandboxed in an iframe on Lens's own origin.
   * On the bar the origin is the application's own page, so it is dropped —
   * markup an application composed from somebody else's data must not be
   * rendered there at all.
   */
  test('the bar does not', () => {
    const panels = withoutPreview(describe(EntryType.MAIL, { subject: 'Hi', html: '<b>x</b>' }))

    expect(panels.some((panel) => panel.kind === 'preview')).toBe(false)
    expect(panels.length).toBeGreaterThan(0)
  })

  test('a purged body is not previewed either', () => {
    const panels = describe(EntryType.MAIL, { subject: 'Hi', html: 'Purged By Lens' })

    expect(panels.some((panel) => panel.kind === 'preview')).toBe(false)
  })
})

group('the one-line summary', () => {
  test('a query reads as its statement, with where it came from', () => {
    const summary = summarise(EntryType.QUERY, {
      sql: 'select * from users',
      time: 12,
      slow: true,
      file: '/app/User.ts',
      line: 8
    })

    expect(summary).toEqual({
      title: 'select * from users',
      short: 'select users',
      sub: '',
      took: 12,
      slow: true,
      file: '/app/User.ts',
      line: 8
    })
  })

  test('an entry with nothing to say falls back to its type', () => {
    expect(summarise(EntryType.VIEW, {}).title).toBe('view')
  })

  /**
   * The timeline is about when and how often, so it needs the statement in a few
   * words rather than a hundred characters of SQL. The table, not the first word
   * after the verb — an earlier attempt answered `select count`, which names the
   * aggregate and not the thing being read.
   */
  test('a statement shortens to its verb and its table', () => {
    const short = (sql: string) => summarise(EntryType.QUERY, { sql }).short

    expect(short('select count(*) as n from comments where article_id = ?')).toBe('select comments')
    expect(short('select * from "articles" where "deleted_at" is null')).toBe('select articles')
    expect(short('insert into "sessions" ("id") values (?)')).toBe('insert into sessions')
    expect(short('update "jobs" set "reserved_at" = ?')).toBe('update jobs')
    expect(short('delete from "jobs" where "id" = ?')).toBe('delete from jobs')
  })

  test('a statement it cannot parse keeps its own words', () => {
    expect(summarise(EntryType.QUERY, { sql: 'pragma foreign_keys = on' }).short).toBe(
      'pragma foreign_keys = on'
    )
  })

  test('anything already short is its own summary', () => {
    expect(summarise(EntryType.VIEW, { view: 'Landing' }).short).toBe('Landing')
  })

  test('a dump reads as its first value', () => {
    const summary = summarise(EntryType.DUMP, { values: [{ text: '{ id: 1 }' }] })

    expect(summary.title).toBe('{ id: 1 }')
  })
})
