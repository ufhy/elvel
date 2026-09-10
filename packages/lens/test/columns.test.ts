import { describe, expect, test } from 'bun:test'
import { EntryType, entryTypes } from '../src/entry-type.ts'
import { cellsFor, headingsFor, shorten } from '../src/http/views/columns.ts'

function headings(type: Parameters<typeof headingsFor>[0]): string[] {
  return headingsFor(type).map((heading) => heading.label)
}

function rendered(type: Parameters<typeof cellsFor>[0], content: Record<string, unknown>) {
  return cellsFor(type, content).map((cell) => cell.text)
}

describe('columnsFor', () => {
  /**
   * Every type that something records gets columns of its own.
   *
   * Written because it did not: nine of the eleven recording types fell through
   * to a truncated JSON blob, which is a list nobody can scan.
   */
  test('every recording entry type has its own columns', () => {
    const recording = [
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

    for (const type of recording) {
      expect(headings(type)).not.toEqual(['Entry'])
    }
  })

  test('a type nothing records yet falls back to one column', () => {
    expect(headings(EntryType.REDIS)).toEqual(['Entry'])
  })

  test('no type is left without any column at all', () => {
    for (const type of entryTypes()) {
      expect(headingsFor(type).length).toBeGreaterThan(0)
    }
  })

  test('a request reads verb, path, status and duration', () => {
    expect(
      rendered(EntryType.REQUEST, {
        method: 'POST',
        uri: '/orders',
        responseStatus: 201,
        duration: 34
      })
    ).toEqual(['POST', '/orders', '201', '34ms'])
  })

  /** Telescope's `requestStatusClass`, and the reason a list is scannable. */
  test('a status badge takes its colour from the class of the code', () => {
    const tone = (status: number) =>
      cellsFor(EntryType.REQUEST, { responseStatus: status })[2]?.tone

    expect(tone(200)).toBe('success')
    expect(tone(301)).toBe('info')
    expect(tone(404)).toBe('warning')
    expect(tone(503)).toBe('danger')
  })

  test('a verb badge follows requestMethodClass', () => {
    const tone = (method: string) => cellsFor(EntryType.REQUEST, { method })[0]?.tone

    expect(tone('GET')).toBe('secondary')
    expect(tone('POST')).toBe('info')
    expect(tone('DELETE')).toBe('danger')
  })

  test('a slow query is marked in the duration cell', () => {
    expect(cellsFor(EntryType.QUERY, { time: 300, slow: true })[2]?.tone).toBe('warning')
    expect(cellsFor(EntryType.QUERY, { time: 3, slow: false })[2]?.tone).toBeUndefined()
  })

  /** A cut value keeps the whole of itself for the `title` attribute. */
  test('a truncated cell carries the full value', () => {
    const long = '/very'.repeat(40)
    const cell = cellsFor(EntryType.REQUEST, { uri: long })[1]

    expect(cell?.text.length).toBeLessThan(long.length)
    expect(cell?.title).toBe(long)
  })

  /**
   * The index folds a repeated failure into one row, so without this the
   * difference between "happened once" and "happening every second" is
   * invisible — and that is the difference that decides what to look at.
   */
  test('an exception shows how many times it has been seen', () => {
    expect(rendered(EntryType.EXCEPTION, { class: 'TypeError', message: 'x' })).toEqual([
      'TypeError',
      'x',
      '1'
    ])
    expect(
      rendered(EntryType.EXCEPTION, { class: 'TypeError', message: 'x', occurrences: 412 })
    ).toEqual(['TypeError', 'x', '412'])
  })

  /**
   * Which columns changed, not what they changed to.
   *
   * A list is read at a glance, often with somebody looking over a shoulder;
   * the values are on the detail page, one click and one intention away.
   */
  test('a model row names the changed columns and not their values', () => {
    const row = rendered(EntryType.MODEL, {
      action: 'updated',
      model: 'User:3',
      changes: { name: 'Ada', email: 'ada@example.test' }
    })

    expect(row).toEqual(['updated', 'User:3', 'name, email'])
    expect(row.join(' ')).not.toContain('ada@example.test')
  })

  test('a model row with no changes is blank rather than broken', () => {
    expect(
      rendered(EntryType.MODEL, { action: 'created', model: 'User:3', changes: null })
    ).toEqual(['created', 'User:3', ''])
  })

  test('a mail row joins the recipients', () => {
    expect(
      rendered(EntryType.MAIL, {
        mailable: 'InvoicePaid',
        to: ['a@x.test', 'b@x.test'],
        subject: 'Paid'
      })
    ).toEqual(['InvoicePaid', 'a@x.test, b@x.test', 'Paid'])
  })

  test('a schedule row explains a skip and a failure in the same column', () => {
    expect(
      rendered(EntryType.SCHEDULED_TASK, {
        task: 'prune',
        outcome: 'skipped',
        reason: 'maintenance'
      })
    ).toEqual(['prune', 'skipped', 'maintenance'])
    expect(
      rendered(EntryType.SCHEDULED_TASK, { task: 'digest', outcome: 'failed', error: 'smtp' })
    ).toEqual(['digest', 'failed', 'smtp'])
  })

  test('a missing field is blank, never the word undefined', () => {
    for (const type of entryTypes()) {
      for (const value of rendered(type, {})) {
        expect(value).not.toContain('undefined')
      }
    }
  })

  test('every cell returns a string, which is what makes one `safe` enough', () => {
    for (const type of entryTypes()) {
      for (const cell of cellsFor(type, { nested: { deep: true }, list: [1, 2] })) {
        expect(typeof cell.text).toBe('string')
      }
    }
  })

  test('a heading exists for every cell a type renders', () => {
    for (const type of entryTypes()) {
      expect(cellsFor(type, {}).length).toBe(headingsFor(type).length)
    }
  })
})

describe('shorten', () => {
  test('leaves a short value alone and marks a long one', () => {
    expect(shorten('short', 10)).toBe('short')
    expect(shorten('0123456789abc', 10)).toBe('012345678…')
    expect(shorten('0123456789abc', 10)).toHaveLength(10)
  })
})
