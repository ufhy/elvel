import { EntryType, type EntryTypeName } from '../../entry-type.ts'
import { methodTone, statusTone, type Tone } from './ui.ts'

export type EntryContent = Record<string, unknown>

/** A column heading, and how its column is aligned. */
export type Heading = { label: string; align?: 'right' | 'center' }

/**
 * One rendered cell.
 *
 * `text` is a string, always, and that is the point: the table renders it
 * through a single `<td safe>`, so escaping attacker-controlled content — a
 * path, a header, a cache key — cannot be forgotten by a new column. The rest
 * is presentation the table applies, not markup a column builds.
 */
export type Cell = {
  text: string
  /** Renders as a coloured badge — Telescope's verb and status pills. */
  tone?: Tone
  align?: 'right' | 'center'
  muted?: boolean
  /** The full value, for a `title` attribute when the text is truncated. */
  title?: string
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

/** One line in a table. The whole value is on the detail page, and in `title`. */
export function shorten(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** A cell whose text is cut, keeping the original for the tooltip. */
function clipped(value: unknown, limit = 60): Cell {
  const full = str(value)

  return full.length <= limit ? { text: full } : { text: shorten(full, limit), title: full }
}

const ms = (value: unknown): Cell =>
  value === null || value === undefined
    ? { text: '-', align: 'right', muted: true }
    : { text: `${str(value)}ms`, align: 'right', muted: true }

type Definition = {
  headings: Heading[]
  cells(content: EntryContent): Cell[]
}

const DEFINITIONS: Partial<Record<EntryTypeName, Definition>> = {
  [EntryType.REQUEST]: {
    headings: [
      { label: 'Verb' },
      { label: 'Path' },
      { label: 'Status', align: 'center' },
      { label: 'Duration', align: 'right' }
    ],
    cells: (content) => [
      { text: str(content.method), tone: methodTone(str(content.method)) },
      clipped(content.uri, 50),
      {
        text: str(content.responseStatus),
        tone: statusTone(Number(content.responseStatus ?? 0)),
        align: 'center'
      },
      ms(content.duration)
    ]
  },

  [EntryType.QUERY]: {
    headings: [
      { label: 'Statement' },
      { label: 'Connection' },
      { label: 'Duration', align: 'right' }
    ],
    cells: (content) => [
      clipped(content.sql, 80),
      { text: str(content.connection), muted: true },
      content.slow === true
        ? { text: `${str(content.time)}ms`, tone: 'warning', align: 'right' }
        : ms(content.time)
    ]
  },

  /**
   * `Seen` earns a column: the index folds repeats into one row, so without it
   * a failure that happened once looks like one happening every second.
   */
  [EntryType.EXCEPTION]: {
    headings: [{ label: 'Type' }, { label: 'Message' }, { label: 'Seen', align: 'right' }],
    cells: (content) => [
      clipped(content.class, 40),
      clipped(content.message, 70),
      { text: str(content.occurrences ?? 1), align: 'right', muted: true }
    ]
  },

  [EntryType.LOG]: {
    headings: [{ label: 'Level' }, { label: 'Message' }, { label: 'Channel' }],
    cells: (content) => [
      { text: str(content.level), tone: levelTone(str(content.level)) },
      clipped(content.message, 80),
      { text: str(content.channel), muted: true }
    ]
  },

  [EntryType.CACHE]: {
    headings: [{ label: 'Event' }, { label: 'Key' }, { label: 'Store' }],
    cells: (content) => [
      { text: str(content.type), tone: cacheTone(str(content.type)) },
      clipped(content.key, 70),
      { text: str(content.store), muted: true }
    ]
  },

  [EntryType.GATE]: {
    headings: [{ label: 'Ability' }, { label: 'Result', align: 'center' }, { label: 'User' }],
    cells: (content) => [
      clipped(content.ability, 60),
      {
        text: str(content.result),
        tone: content.result === 'denied' ? 'danger' : 'success',
        align: 'center'
      },
      { text: str(content.user), muted: true }
    ]
  },

  [EntryType.MODEL]: {
    headings: [{ label: 'Action' }, { label: 'Model' }, { label: 'Changed' }],
    cells: (content) => [
      { text: str(content.action), tone: actionTone(str(content.action)) },
      clipped(content.model, 50),
      { text: changedKeys(content.changes), muted: true }
    ]
  },

  [EntryType.SCHEDULED_TASK]: {
    headings: [{ label: 'Task' }, { label: 'Outcome', align: 'center' }, { label: 'Why' }],
    cells: (content) => [
      clipped(content.task, 60),
      {
        text: str(content.outcome),
        tone:
          content.outcome === 'failed'
            ? 'danger'
            : content.outcome === 'ran'
              ? 'success'
              : 'warning',
        align: 'center'
      },
      clipped(content.reason ?? content.error, 60)
    ]
  },

  [EntryType.MAIL]: {
    headings: [{ label: 'Mailable' }, { label: 'To' }, { label: 'Subject' }],
    cells: (content) => [
      clipped(content.mailable, 40),
      clipped(joined(content.to), 45),
      clipped(content.subject, 55)
    ]
  },

  [EntryType.NOTIFICATION]: {
    headings: [
      { label: 'Notification' },
      { label: 'Channel' },
      { label: 'Outcome', align: 'center' }
    ],
    cells: (content) => [
      clipped(content.notification, 45),
      { text: str(content.channel), muted: true },
      {
        text: str(content.outcome),
        tone:
          content.outcome === 'failed'
            ? 'danger'
            : content.outcome === 'sent'
              ? 'success'
              : 'warning',
        align: 'center'
      }
    ]
  },

  [EntryType.EVENT]: {
    headings: [{ label: 'Name' }, { label: 'Payload' }],
    cells: (content) => [
      clipped(content.name, 50),
      clipped(JSON.stringify(content.payload ?? null), 80)
    ]
  }
}

/** Nothing records this type yet, so show whatever an entry happens to hold. */
const FALLBACK: Definition = {
  headings: [{ label: 'Entry' }],
  cells: (content) => [clipped(JSON.stringify(content), 120)]
}

export function headingsFor(type: EntryTypeName): Heading[] {
  return (DEFINITIONS[type] ?? FALLBACK).headings
}

export function cellsFor(type: EntryTypeName, content: EntryContent): Cell[] {
  return (DEFINITIONS[type] ?? FALLBACK).cells(content)
}

function levelTone(level: string): Tone {
  if (['emergency', 'alert', 'critical', 'error'].includes(level)) return 'danger'
  if (['warning', 'notice'].includes(level)) return 'warning'

  return 'secondary'
}

function cacheTone(kind: string): Tone {
  if (kind === 'hit') return 'success'
  if (kind === 'missed') return 'warning'
  if (kind === 'forget') return 'danger'

  return 'info'
}

function actionTone(action: string): Tone {
  if (action === 'created') return 'success'
  if (action === 'deleted') return 'danger'

  return 'info'
}

/** `name, email` — which columns changed, not what they changed to. */
function changedKeys(changes: unknown): string {
  if (changes === null || typeof changes !== 'object') return ''

  return shorten(Object.keys(changes as Record<string, unknown>).join(', '), 50)
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.map(str).join(', ') : str(value)
}
