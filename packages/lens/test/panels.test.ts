import { describe, expect, test } from 'bun:test'
import { JsxViewFactory } from '@elvel/view'
import { EntryResult } from '../src/entry-result.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { Entries } from '../src/http/views/entries.tsx'
import { Entry } from '../src/http/views/entry.tsx'
import { Monitoring } from '../src/http/views/monitoring.tsx'
import { Panels } from '../src/http/views/panels.tsx'

const view = new JsxViewFactory({ doctype: false })

async function render(type: EntryTypeName, content: Record<string, unknown>): Promise<string> {
  return await view.render(Panels, { type, content })
}

describe('detail panels', () => {
  test('a request is named field by field rather than dumped', async () => {
    const markup = await render(EntryType.REQUEST, {
      method: 'POST',
      uri: '/orders',
      responseStatus: 201,
      duration: 12,
      headers: { accept: 'application/json' }
    })

    expect(markup).toContain('Method')
    expect(markup).toContain('POST')
    expect(markup).toContain('Headers')
    expect(markup).toContain('accept')
  })

  /** An empty map is left out, not shown as an empty card. */
  test('empty sections are absent', async () => {
    const markup = await render(EntryType.REQUEST, { method: 'GET', headers: {}, payload: {} })

    expect(markup).not.toContain('Headers')
    expect(markup).not.toContain('Payload')
  })

  test('an exception marks the failing line in its source', async () => {
    const markup = await render(EntryType.EXCEPTION, {
      class: 'TypeError',
      message: 'boom',
      file: '/app/x.ts',
      line: 12,
      linePreview: { 11: 'const a = 1', 12: 'throw new TypeError()', 13: '}' }
    })

    expect(markup).toContain('Source')
    expect(markup).toContain('blame')
    expect(markup).toMatch(/blame[^]*throw new TypeError/)
  })

  test('the raw content is always there, and always collapsed', async () => {
    for (const type of [EntryType.REQUEST, EntryType.REDIS]) {
      const markup = await render(type, { anything: 1 })

      expect(markup).toContain('Raw content')
      expect(markup).toContain('<details>')
      expect(markup).not.toContain('<details open')
    }
  })
})

describe('the mail preview', () => {
  /**
   * The body is markup an application built from data somebody else supplied.
   *
   * Rendering it into the dashboard's own document would hand that document to
   * whoever supplied the data — so it goes in a frame with `sandbox=""`, which
   * is the fully restricted form: no scripts, no same-origin, no forms.
   */
  test('renders the message in a fully sandboxed frame', async () => {
    const markup = await render(EntryType.MAIL, {
      mailable: 'InvoicePaid',
      to: ['ada@example.test'],
      subject: 'Paid',
      html: '<p>Hello</p><script>alert(1)</script>'
    })

    expect(markup).toContain('<iframe')
    expect(markup).toContain('sandbox=""')
    expect(markup).not.toContain('allow-scripts')
    expect(markup).not.toContain('allow-same-origin')

    /**
     * The script tag lives inside `srcdoc="…"` and nowhere else.
     *
     * That is the point of the frame, not a leak. Asserting its absence from
     * the whole document was the first version of this test, and it was wrong
     * for the same reason the waterfall's was: a copy sitting inert inside an
     * attribute is not a copy in the page.
     */
    const outside = markup.replace(/srcdoc="[^"]*"/, 'srcdoc=""')

    expect(outside).not.toContain('<script>')
  })

  /** And nothing in a message can end the attribute early. */
  test('a quote in the body cannot break out of srcdoc', async () => {
    const markup = await render(EntryType.MAIL, { html: '<p>" onload="alert(1)</p>' })

    expect(markup).not.toMatch(/onload="alert\(1\)"/)
    expect(markup).toContain('&#34;')
  })

  test('a purged or missing body shows no frame at all', async () => {
    expect(await render(EntryType.MAIL, { html: 'Purged By Lens' })).not.toContain('<iframe')
    expect(await render(EntryType.MAIL, {})).not.toContain('<iframe')
  })

  test('names every recipient field', async () => {
    const markup = await render(EntryType.MAIL, {
      mailable: 'InvoicePaid',
      from: ['Shop <a@x.test>'],
      to: ['b@x.test', 'c@x.test'],
      cc: ['d@x.test'],
      subject: 'Paid'
    })

    expect(markup).toContain('b@x.test, c@x.test')
    expect(markup).toContain('Cc')
    expect(markup).not.toContain('Bcc')
  })
})

describe('every recording type has a panel', () => {
  test('none of them falls through to raw content alone', async () => {
    const typed = [
      EntryType.REQUEST,
      EntryType.QUERY,
      EntryType.EXCEPTION,
      EntryType.LOG,
      EntryType.CACHE,
      EntryType.GATE,
      EntryType.MODEL,
      EntryType.SCHEDULED_TASK,
      EntryType.MAIL,
      EntryType.NOTIFICATION,
      EntryType.EVENT,
      EntryType.CLIENT_REQUEST,
      EntryType.VIEW,
      EntryType.BATCH,
      EntryType.JOB,
      EntryType.COMMAND,
      EntryType.DUMP
    ]

    /** Content shaped like the watcher that records it, or a panel finds nothing. */
    const sample: Record<string, Record<string, unknown>> = {
      request: { method: 'GET', uri: '/x' },
      query: { sql: 'select 1', connection: 'main' },
      exception: { class: 'Error', message: 'x' },
      log: { level: 'error', message: 'x' },
      cache: { type: 'hit', key: 'k' },
      gate: { ability: 'view', result: 'allowed' },
      model: { action: 'created', model: 'User:1' },
      schedule: { task: 'prune', outcome: 'ran' },
      mail: { mailable: 'X', subject: 'S' },
      notification: { notification: 'X', channel: 'mail' },
      event: { name: 'order.placed' },
      client_request: { method: 'GET', uri: 'https://x.test/y', host: 'x.test' },
      view: { view: 'Layout', size: 100 },
      batch: { batch: 'b1', totalJobs: 3 },
      job: { name: 'SendInvoice', status: 'pending' },
      command: { command: 'migrate', exitCode: 0 },
      dump: { values: [{ label: null, text: '{ id: 1 }' }], file: '/a.ts', line: 3 }
    }

    for (const type of typed) {
      const markup = await render(type, sample[type] ?? {})
      const cards = markup.split('class="card"').length - 1

      // More than the collapsed raw block on its own.
      expect(`${type} has ${String(cards)} card(s)`).not.toBe(`${type} has 1 card(s)`)
    }
  })
})

describe('the theme', () => {
  /**
   * A prop declared and never passed is invisible to the compiler.
   *
   * Found exactly that way, on a running dashboard: every screen took a `theme`
   * prop, not one of them handed it to the layout, and the page kept rendering
   * `data-theme="system"` while the server was reading `dark` off the cookie
   * perfectly well. TypeScript has nothing to say about a prop nobody uses.
   */
  test('every screen hands its choice to the layout', async () => {
    const screens: Array<[string, () => Promise<string>]> = [
      [
        'entries',
        () =>
          view.render(Entries, {
            path: 'lens',
            type: EntryType.REQUEST,
            status: 'enabled' as const,
            paused: false,
            theme: 'dark' as const,
            entries: [],
            limit: 50
          })
      ],
      [
        'entry',
        () =>
          view.render(Entry, {
            path: 'lens',
            entry: new EntryResult('u', 1, 'b', EntryType.QUERY, undefined, {}, undefined, []),
            batch: [],
            paused: false,
            theme: 'dark' as const
          })
      ],
      [
        'monitoring',
        () =>
          view.render(Monitoring, { path: 'lens', tags: [], paused: false, theme: 'dark' as const })
      ]
    ]

    for (const [name, render] of screens) {
      expect(`${name}: ${(await render()).includes('data-theme="dark"') ? 'yes' : 'no'}`).toBe(
        `${name}: yes`
      )
    }
  })

  test('no choice leaves it to the system', async () => {
    const markup = await view.render(Monitoring, { path: 'lens', tags: [], paused: false })

    expect(markup).toContain('data-theme="system"')
  })

  /** The toggle offers the opposite of what is showing. */
  test('the button switches to the other theme', async () => {
    const dark = await view.render(Monitoring, {
      path: 'lens',
      tags: [],
      paused: false,
      theme: 'dark' as const
    })
    const light = await view.render(Monitoring, { path: 'lens', tags: [], paused: false })

    expect(dark).toContain('value="light"')
    expect(light).toContain('value="dark"')
  })
})
