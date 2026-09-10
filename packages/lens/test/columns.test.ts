import { describe, expect, test } from 'bun:test'
import { EntryType, entryTypes } from '../src/entry-type.ts'
import { columnsFor, shorten } from '../src/http/views/columns.ts'

function headings(type: Parameters<typeof columnsFor>[0]): string[] {
  return columnsFor(type).map((column) => column.heading)
}

function rendered(type: Parameters<typeof columnsFor>[0], content: Record<string, unknown>) {
  return columnsFor(type).map((column) => column.text(content))
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
      expect(headings(type)).not.toEqual(['entry'])
    }
  })

  test('a type nothing records yet falls back to one column', () => {
    expect(headings(EntryType.REDIS)).toEqual(['entry'])
  })

  test('no type is left without any column at all', () => {
    for (const type of entryTypes()) {
      expect(columnsFor(type).length).toBeGreaterThan(0)
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
    ).toEqual(['POST', '/orders', '201', '34 ms'])
  })

  test('a status colours itself by class', () => {
    const status = columnsFor(EntryType.REQUEST)[2]

    expect(status?.cellClass?.({ responseStatus: 200 })).toContain('s2')
    expect(status?.cellClass?.({ responseStatus: 503 })).toContain('s5')
  })

  test('a slow query is marked in the duration cell', () => {
    const took = columnsFor(EntryType.QUERY)[2]

    expect(took?.cellClass?.({ slow: true })).toContain('s5')
    expect(took?.cellClass?.({ slow: false })).not.toContain('s5')
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

  test('every column returns a string, which is what makes one `safe` enough', () => {
    for (const type of entryTypes()) {
      for (const column of columnsFor(type)) {
        expect(typeof column.text({ nested: { deep: true }, list: [1, 2] })).toBe('string')
      }
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
