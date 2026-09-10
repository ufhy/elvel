import { EntryType, type EntryTypeName } from '../../entry-type.ts'

export type EntryContent = Record<string, unknown>

/**
 * One column of a list, as text.
 *
 * Text and not JSX, deliberately. The first version of this file wrote a row
 * per type in JSX with a `safe` attribute on each cell, which meant the
 * escaping of attacker-controlled content — a request path, a header, a cache
 * key — depended on remembering an attribute nine times over. Returning strings
 * moves that to one `<td safe>` in the table, so a new column cannot forget it.
 */
export type Column = {
  heading: string
  text(content: EntryContent): string
  /** An extra class on the cell, for a status colour or a right-aligned number. */
  cellClass?(content: EntryContent): string | undefined
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value)

/** One line, whatever it is. The whole thing is on the detail page. */
export function shorten(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

const ms =
  (key: string): Column['text'] =>
  (content) =>
    content[key] === undefined || content[key] === null ? '' : `${text(content[key])} ms`

const COLUMNS: Partial<Record<EntryTypeName, Column[]>> = {
  [EntryType.REQUEST]: [
    { heading: 'verb', text: (content) => text(content.method), cellClass: () => 'method' },
    { heading: 'path', text: (content) => shorten(text(content.uri)) },
    {
      heading: 'status',
      text: (content) => text(content.responseStatus),
      cellClass: (content) => `method s${Math.floor(Number(content.responseStatus ?? 0) / 100)}`
    },
    { heading: 'took', text: ms('duration'), cellClass: () => 'num' }
  ],

  [EntryType.QUERY]: [
    { heading: 'statement', text: (content) => shorten(text(content.sql)) },
    { heading: 'connection', text: (content) => text(content.connection) },
    {
      heading: 'took',
      text: ms('time'),
      cellClass: (content) => (content.slow === true ? 'num s5' : 'num')
    }
  ],

  /**
   * `occurrences` earns a column of its own.
   *
   * The index shows one row per family, so without it the difference between a
   * failure that happened once and one happening every second is invisible —
   * which is the difference that decides what to look at first.
   */
  [EntryType.EXCEPTION]: [
    { heading: 'class', text: (content) => text(content.class) },
    { heading: 'message', text: (content) => shorten(text(content.message)) },
    { heading: 'seen', text: (content) => text(content.occurrences ?? 1), cellClass: () => 'num' }
  ],

  [EntryType.LOG]: [
    { heading: 'level', text: (content) => text(content.level), cellClass: () => 'method' },
    { heading: 'message', text: (content) => shorten(text(content.message)) },
    { heading: 'channel', text: (content) => text(content.channel) }
  ],

  [EntryType.CACHE]: [
    { heading: 'event', text: (content) => text(content.type), cellClass: () => 'method' },
    { heading: 'key', text: (content) => shorten(text(content.key)) },
    { heading: 'store', text: (content) => text(content.store) }
  ],

  [EntryType.GATE]: [
    { heading: 'ability', text: (content) => text(content.ability) },
    {
      heading: 'result',
      text: (content) => text(content.result),
      cellClass: (content) => (content.result === 'denied' ? 'method s5' : 'method s2')
    },
    { heading: 'user', text: (content) => text(content.user) }
  ],

  [EntryType.MODEL]: [
    { heading: 'action', text: (content) => text(content.action), cellClass: () => 'method' },
    { heading: 'model', text: (content) => text(content.model) },
    { heading: 'changed', text: (content) => changedKeys(content.changes) }
  ],

  [EntryType.SCHEDULED_TASK]: [
    { heading: 'task', text: (content) => text(content.task) },
    {
      heading: 'outcome',
      text: (content) => text(content.outcome),
      cellClass: (content) => (content.outcome === 'failed' ? 'method s5' : 'method')
    },
    { heading: 'why', text: (content) => shorten(text(content.reason ?? content.error ?? '')) }
  ],

  [EntryType.MAIL]: [
    { heading: 'mailable', text: (content) => text(content.mailable) },
    { heading: 'to', text: (content) => shorten(joined(content.to), 60) },
    { heading: 'subject', text: (content) => shorten(text(content.subject), 70) }
  ],

  [EntryType.NOTIFICATION]: [
    { heading: 'notification', text: (content) => text(content.notification) },
    { heading: 'channel', text: (content) => text(content.channel) },
    {
      heading: 'outcome',
      text: (content) => text(content.outcome),
      cellClass: (content) => (content.outcome === 'failed' ? 'method s5' : 'method')
    }
  ],

  [EntryType.EVENT]: [
    { heading: 'name', text: (content) => text(content.name) },
    { heading: 'payload', text: (content) => shorten(JSON.stringify(content.payload ?? null), 90) }
  ]
}

/** The columns for a type, or one column holding whatever the entry has. */
export function columnsFor(type: EntryTypeName): Column[] {
  return (
    COLUMNS[type] ?? [
      { heading: 'entry', text: (content) => shorten(JSON.stringify(content), 140) }
    ]
  )
}

/** `name, email` — which columns changed, not what they changed to. */
function changedKeys(changes: unknown): string {
  if (changes === null || typeof changes !== 'object') return ''

  return shorten(Object.keys(changes as Record<string, unknown>).join(', '), 60)
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.map(text).join(', ') : text(value)
}
