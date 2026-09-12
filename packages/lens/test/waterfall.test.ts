import { describe, expect, test } from 'bun:test'
import { enterWorkContext } from '@elvel/core'
import { JsxViewFactory } from '@elvel/view'
import { IncomingEntry } from '../src/entry.ts'
import { EntryResult } from '../src/entry-result.ts'
import { EntryType, type EntryTypeName } from '../src/entry-type.ts'
import { Waterfall } from '../src/http/views/waterfall.tsx'
import { Recorder } from '../src/recorder.ts'

const view = new JsxViewFactory({ doctype: false })

function result(
  type: EntryTypeName,
  content: Record<string, unknown>,
  uuid: string = crypto.randomUUID()
): EntryResult {
  return new EntryResult(uuid, 1, 'b1', type, undefined, content, '2026-09-11 00:00:00', [])
}

async function draw(batch: EntryResult[], current = ''): Promise<string> {
  return await view.render(Waterfall, { path: 'lens', batch, current })
}

/** `left:12.34%;width:5.00%` → the two numbers. */
function bars(markup: string): Array<{ left: number; width: number }> {
  return [...markup.matchAll(/left:([\d.]+)%;width:([\d.]+)%/g)].map((m) => ({
    left: Number(m[1]),
    width: Number(m[2])
  }))
}

describe('the recorder stamps an offset', () => {
  /**
   * The whole reason a waterfall is possible: `created_at` is stored to the
   * second, so every entry in a batch carries the same timestamp and cannot
   * place anything on an axis.
   */
  test('every recorded entry knows where it sat in the unit of work', async () => {
    const lens = new Recorder()

    lens.enable(true)
    enterWorkContext()
    lens.start()

    const first = IncomingEntry.make({ sql: 'a' })
    lens.record(EntryType.QUERY, first)

    await Bun.sleep(12)

    const later = IncomingEntry.make({ sql: 'b' })
    lens.record(EntryType.QUERY, later)

    expect(typeof first.content.offsetMs).toBe('number')
    expect(Number(later.content.offsetMs)).toBeGreaterThan(Number(first.content.offsetMs))
  })

  test('an offset is never negative', () => {
    const lens = new Recorder()

    lens.enable(true)
    enterWorkContext()
    lens.start()

    const entry = IncomingEntry.make({})
    lens.record(EntryType.QUERY, entry)

    expect(Number(entry.content.offsetMs)).toBeGreaterThanOrEqual(0)
  })
})

describe('the waterfall', () => {
  test('places a bar by its offset and sizes it by its duration', async () => {
    const markup = await draw([
      result(EntryType.QUERY, { sql: 'a', offsetMs: 0, time: 25 }),
      result(EntryType.QUERY, { sql: 'b', offsetMs: 50, time: 50 })
    ])

    const drawn = bars(markup)

    expect(drawn).toHaveLength(2)
    expect(drawn[0]?.left).toBe(0)
    expect(drawn[0]?.width).toBeCloseTo(25, 0)
    expect(drawn[1]?.left).toBeCloseTo(50, 0)
    expect(drawn[1]?.width).toBeCloseTo(50, 0)
  })

  /**
   * A request is recorded last, because the response has to exist first — so
   * its offset is the end of the work, not the beginning. Drawn there it would
   * put the longest bar in the wrong place entirely.
   */
  test('a request spans the whole unit of work rather than sitting at its end', async () => {
    const markup = await draw([
      result(EntryType.REQUEST, { method: 'GET', uri: '/x', offsetMs: 100, duration: 100 }),
      result(EntryType.QUERY, { sql: 'a', offsetMs: 10, time: 5 })
    ])

    const first = bars(markup)[0]

    expect(first?.left).toBe(0)
    expect(first?.width).toBeCloseTo(100, 0)
  })

  test('an instant entry still gets something to aim at', async () => {
    const markup = await draw([
      result(EntryType.CACHE, { type: 'hit', key: 'k', offsetMs: 5 }),
      result(EntryType.QUERY, { sql: 'a', offsetMs: 0, time: 500 })
    ])

    expect(bars(markup).every((bar) => bar.width > 0)).toBe(true)
  })

  test('bars come out in the order they happened', async () => {
    const markup = await draw([
      result(EntryType.QUERY, { sql: 'third', offsetMs: 30 }),
      result(EntryType.QUERY, { sql: 'first', offsetMs: 1 }),
      result(EntryType.QUERY, { sql: 'second', offsetMs: 20 })
    ])

    expect(markup.indexOf('first')).toBeLessThan(markup.indexOf('second'))
    expect(markup.indexOf('second')).toBeLessThan(markup.indexOf('third'))
  })

  /**
   * Entries recorded before offsets existed must not be given invented ones —
   * but they must still be listed. Losing the summaries was a regression the
   * dashboard test caught.
   */
  test('lists without an axis when nothing is timed', async () => {
    const markup = await draw([result(EntryType.QUERY, { sql: 'select * from orders' })])

    expect(markup).toContain('no axis')
    expect(markup).toContain('select * from orders')
    expect(bars(markup)).toHaveLength(0)
  })

  test('marks the entry being viewed', async () => {
    const subject = result(EntryType.QUERY, { sql: 'a', offsetMs: 0 }, 'here-i-am')
    const markup = await draw(
      [subject, result(EntryType.QUERY, { sql: 'b', offsetMs: 5 })],
      'here-i-am'
    )

    expect(markup).toContain('fall-row here')
    expect([...markup.matchAll(/fall-row here/g)]).toHaveLength(1)
  })

  /**
   * A recorded value reaches this page like any other.
   *
   * Asserted on the rendered *text* and on breaking out of the `title`
   * attribute, which is the pair that matters. The first version of this test
   * searched the whole markup for the script tag and failed on the copy sitting
   * inside `title="…"` — where `<` starts nothing, and where `@kitajs/html`
   * escapes the quotes that could have ended the attribute. The code was right
   * and the assertion was too broad.
   */
  test('escapes what it draws, and nothing escapes its attributes', async () => {
    const markup = await draw([
      result(EntryType.QUERY, {
        sql: 'select \'<script>alert(1)</script>\' and " onmouseover="alert(2)',
        offsetMs: 0,
        time: 1
      })
    ])

    // The text a browser would render.
    const text = markup.replace(/title="[^"]*"/g, '')

    expect(text).not.toContain('<script>')
    expect(text).toContain('&lt;script&gt;')

    // And no attribute can be closed early.
    expect(markup).not.toMatch(/onmouseover="alert\(2\)"/)
  })
})
