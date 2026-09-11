import { describe, expect, test } from 'bun:test'
import { JsxViewFactory } from '@elvel/view'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
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
      EntryType.EVENT
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
      event: { name: 'order.placed' }
    }

    for (const type of typed) {
      const markup = await render(type, sample[type] ?? {})
      const cards = markup.split('class="card"').length - 1

      // More than the collapsed raw block on its own.
      expect(`${type} has ${String(cards)} card(s)`).not.toBe(`${type} has 1 card(s)`)
    }
  })
})
