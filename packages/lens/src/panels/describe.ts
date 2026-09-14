import type { EntryContent } from '../entry.ts'
import { EntryType, type EntryTypeName } from '../entry-type.ts'

/**
 * What an entry's detail is, decided once and rendered twice.
 *
 * The dashboard renders these as TSX (`http/views/panels.tsx`); the inspection
 * bar sends them as JSON and draws them in the browser. Before this file the
 * decision lived inside the TSX, so the bar had no way to reach it and would
 * have grown a second, drifting answer to what a query's detail is.
 *
 * A panel says *what* to show, never how. No markup, no classes, no colours —
 * those belong to whichever renderer picked it up.
 */
export type Panel =
  /** Named values, the answer before the evidence. Empty values are dropped. */
  | { kind: 'facts'; rows: Array<[string, string]> }
  /** A record as a two-column table. */
  | { kind: 'mapping'; title: string; value: Record<string, unknown> }
  /** Anything JSON-encodable, pretty-printed. */
  | { kind: 'block'; title: string; value: unknown }
  /** Text meant to be read as code — SQL, a dump. */
  | { kind: 'code'; title: string; value: string }
  /** Numbered source lines with the failing one marked. */
  | { kind: 'source'; lines: Array<[number, string]>; blame: number }
  /** A stack, already trimmed. */
  | { kind: 'trace'; frames: Array<{ file: string; line: string }> }
  /**
   * An email body, as markup.
   *
   * The one panel that carries HTML somebody else composed. The dashboard puts
   * it in a sandboxed iframe on its own origin; the bar drops it, because on the
   * bar that origin is the application's own page. See `withoutPreview`.
   */
  | { kind: 'preview'; html: string }

/** The whole detail of one entry, in order. */
export function describe(type: EntryTypeName, content: EntryContent): Panel[] {
  return panelsFor(type, content).filter(isWorthShowing)
}

/**
 * The same panels, minus anything that must not reach a page we do not own.
 *
 * Called by the bar and not by the dashboard. A mail body is HTML an application
 * composed from data somebody else supplied: rendering it inside the dashboard
 * costs the dashboard at worst, and the dashboard sandboxes it anyway. Rendering
 * it inside the application's own page would hand an attacker the application.
 */
export function withoutPreview(panels: Panel[]): Panel[] {
  return panels.filter((panel) => panel.kind !== 'preview')
}

/**
 * An entry as one line — what a list shows before anything is opened.
 *
 * Lived in the bar's client script until this moved here. On the server it is
 * testable in Bun, it cannot disagree with {@link describe}, and the browser
 * stops needing to know the shape of eighteen kinds of content.
 */
export type Summary = {
  title: string
  /**
   * The same thing in a few words, for a place that is not about reading it.
   *
   * The timeline is about *when* and *how often*; printing a hundred characters
   * of SQL on every lane turned it back into the query list it sits beside. A
   * statement becomes its verb and its table; everything else is already short
   * enough to be its own summary.
   */
  short: string
  sub: string
  /** Milliseconds, when the entry is something that took time. */
  took?: number
  slow: boolean
  file?: string
  line?: number
}

export function summarise(type: EntryTypeName, content: EntryContent): Summary {
  const made = summaryFor(type, content)

  const title = made.title === undefined || made.title === '' ? type : made.title

  return {
    title,
    short: shorten(type, title),
    sub: made.sub ?? '',
    took: typeof made.took === 'number' ? made.took : undefined,
    slow: made.slow === true,
    file: made.file === undefined ? undefined : String(made.file),
    line: made.line === undefined ? undefined : Number(made.line)
  }
}

type Draft = {
  title?: string
  sub?: string
  took?: unknown
  slow?: unknown
  file?: unknown
  line?: unknown
}

function summaryFor(type: EntryTypeName, content: EntryContent): Draft {
  switch (type) {
    case EntryType.REQUEST:
      return {
        title: `${str(content.method)} ${str(content.uri)}`.trim(),
        sub: str(content.responseStatus),
        took: content.duration
      }
    case EntryType.QUERY:
      return {
        title: str(content.sql),
        sub: str(content.connection),
        took: content.time,
        slow: content.slow,
        file: content.file,
        line: content.line
      }
    case EntryType.EXCEPTION:
      return {
        title: str(content.message),
        sub: str(content.class),
        file: content.file,
        line: content.line
      }
    case EntryType.LOG:
      return { title: str(content.message), sub: str(content.level) }
    case EntryType.CACHE:
      return { title: str(content.key), sub: str(content.type) }
    case EntryType.REDIS:
      return {
        title: str(content.command),
        sub: str(content.connection),
        took: content.time,
        slow: content.slow
      }
    case EntryType.GATE:
      return {
        title: str(content.ability),
        sub: str(content.result),
        file: content.file,
        line: content.line
      }
    case EntryType.MODEL:
      return { title: str(content.model), sub: str(content.action) }
    case EntryType.JOB:
      return { title: str(content.name), sub: str(content.status) }
    case EntryType.BATCH:
      return { title: str(content.name), sub: `${str(content.totalJobs)} jobs` }
    case EntryType.SCHEDULED_TASK:
      return { title: str(content.task), sub: str(content.outcome) }
    case EntryType.MAIL:
      return { title: str(content.subject), sub: joined(content.to) }
    case EntryType.NOTIFICATION:
      return { title: str(content.notification), sub: str(content.channel) }
    case EntryType.EVENT:
      return { title: str(content.name), sub: '' }
    case EntryType.COMMAND:
      return {
        title: str(content.command),
        sub: `exit ${str(content.exitCode)}`,
        took: content.duration
      }
    case EntryType.CLIENT_REQUEST:
      return {
        title: `${str(content.method)} ${str(content.uri)}`.trim(),
        sub: str(content.responseStatus),
        took: content.duration
      }
    case EntryType.VIEW:
      return {
        title: str(content.view),
        sub: content.size === undefined ? '' : `${str(content.size)} bytes`,
        took: content.time
      }
    case EntryType.DUMP:
      return { title: firstDump(content), sub: '', file: content.file, line: content.line }
    default:
      return { title: '', sub: '' }
  }
}

/**
 * The first dumped value's text, flattened.
 *
 * A dumped object is formatted across several lines, and both the bar and the
 * dashboard put this in a one-line column — so the row rendered broken. The
 * formatting is kept: it is what the detail panel shows.
 */
/**
 * `select count(*) as n from "comments" where …` becomes `select comments`.
 *
 * The table, not the first word after the verb — the first attempt returned
 * `select count`, which names the aggregate and not the thing being read. For
 * `select` and `delete` the table follows `from`; for the others it follows the
 * verb directly.
 */
const VERB = /^\s*(select|insert\s+into|update|delete\s+from|replace\s+into)\b/i
const AFTER_FROM = /\bfrom\s+[`"'[]?([\w.]+)/i

function shorten(type: EntryTypeName, title: string): string {
  if (type === EntryType.QUERY) {
    const found = VERB.exec(title)
    const verb = found?.[1]?.toLowerCase().replace(/\s+/g, ' ')

    if (verb !== undefined) {
      const table =
        verb === 'select' || verb === 'delete from'
          ? AFTER_FROM.exec(title)?.[1]
          : new RegExp(`${verb.replace(/ /g, '\\s+')}\\s+[\`"'[]?([\\w.]+)`, 'i').exec(title)?.[1]

      if (table !== undefined) return `${verb} ${table}`
    }
  }

  return title.length <= 60 ? title : `${title.slice(0, 59)}\u2026`
}

function firstDump(content: EntryContent): string {
  const values = Array.isArray(content.values) ? content.values : []
  const first = values[0] as { text?: unknown } | undefined

  if (first === undefined) return ''

  return str(first.text)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

function panelsFor(type: EntryTypeName, content: EntryContent): Panel[] {
  switch (type) {
    case EntryType.REQUEST:
      return [
        facts([
          ['Method', str(content.method)],
          ['URI', str(content.uri)],
          ['Route', str(content.route)],
          ['Status', str(content.responseStatus)],
          ['Duration', ms(content.duration)],
          ['Client', str(content.ipAddress)]
        ]),
        mapping('Headers', content.headers),
        mapping('Payload', content.payload),
        mapping('Session', content.session),
        block('Response', content.response)
      ]

    case EntryType.QUERY:
      return [
        facts([
          ['Connection', str(content.connection)],
          ['Duration', ms(content.time)],
          ['Bindings', str(content.bindings)],
          ['Called from', where(content)]
        ]),
        code('Statement', str(content.sql))
      ]

    case EntryType.EXCEPTION:
      return [
        facts([
          ['Type', str(content.class)],
          ['Message', str(content.message)],
          ['Where', where(content)],
          ['Seen', str(content.occurrences ?? 1)]
        ]),
        source(content.linePreview, Number(content.line ?? 0)),
        trace(content.trace)
      ]

    case EntryType.MAIL:
      return [
        facts([
          ['Mailable', str(content.mailable)],
          ['Mailer', str(content.mailer)],
          ['Subject', str(content.subject)],
          ['From', joined(content.from)],
          ['To', joined(content.to)],
          ['Cc', joined(content.cc)],
          ['Bcc', joined(content.bcc)],
          ['Reply to', joined(content.replyTo)],
          ['Attachments', content.attachments === 0 ? '' : str(content.attachments)]
        ]),
        preview(content.html),
        block('Plain text', content.text)
      ]

    case EntryType.CLIENT_REQUEST:
      return [
        facts([
          ['Method', str(content.method)],
          ['URL', str(content.uri)],
          ['Host', str(content.host)],
          ['Status', str(content.responseStatus)],
          ['Response size', content.responseSize === 0 ? '' : bytes(content.responseSize)]
        ])
      ]

    case EntryType.REDIS:
      return [
        facts([
          ['Connection', str(content.connection)],
          ['Duration', content.failed === true ? '' : ms(content.time)],
          ['Failed', content.failed === true ? 'yes' : ''],
          ['Error', str(content.error)]
        ]),
        code('Command', str(content.command))
      ]

    case EntryType.CACHE:
      return [
        facts([
          ['Event', str(content.type)],
          ['Key', str(content.key)],
          ['Store', str(content.store)],
          ['Expires in', content.expiration === undefined ? '' : `${str(content.expiration)}s`],
          ['Value', content.value === undefined ? '' : JSON.stringify(content.value)]
        ])
      ]

    case EntryType.GATE:
      return [
        facts([
          ['Ability', str(content.ability)],
          ['Result', str(content.result)],
          ['User', str(content.user)],
          ['Arguments', joined(content.arguments)],
          ['Checked at', where(content)]
        ])
      ]

    case EntryType.MODEL:
      return [
        facts([
          ['Action', str(content.action)],
          ['Model', str(content.model)]
        ]),
        mapping('Changes', content.changes)
      ]

    case EntryType.NOTIFICATION:
      return [
        facts([
          ['Notification', str(content.notification)],
          ['Channel', str(content.channel)],
          ['Outcome', str(content.outcome)],
          ['Id', str(content.id)],
          ['Error', str(content.error)]
        ])
      ]

    case EntryType.LOG:
      return [
        facts([
          ['Level', str(content.level)],
          ['Channel', str(content.channel)],
          ['Message', str(content.message)]
        ]),
        mapping('Context', content.context)
      ]

    case EntryType.SCHEDULED_TASK:
      return [
        facts([
          ['Task', str(content.task)],
          ['Outcome', str(content.outcome)],
          ['Reason', str(content.reason)],
          ['Error', str(content.error)]
        ])
      ]

    case EntryType.DUMP: {
      const values = Array.isArray(content.values) ? content.values : []

      return [
        facts([['From', where(content)]]),
        ...values.map((value) => {
          const one = value as { label?: unknown; text?: unknown }
          const label = one.label === null || one.label === undefined ? '' : ` ${str(one.label)}`

          return code(`Dump${label}`, str(one.text))
        })
      ]
    }

    case EntryType.VIEW:
      return [
        facts([
          ['View', str(content.view)],
          ['Markup size', content.size === undefined ? '' : bytes(content.size)],
          ['Duration', ms(content.time)]
        ])
      ]

    case EntryType.BATCH:
      return [
        facts([
          ['Batch', str(content.batch)],
          ['Name', str(content.name)],
          ['Jobs', str(content.totalJobs)],
          ['Queue', str(content.queue)],
          ['Connection', str(content.connection)]
        ])
      ]

    case EntryType.JOB:
      return [
        facts([
          ['Job', str(content.name)],
          ['Status', str(content.status)],
          ['Queue', str(content.queue)],
          ['Connection', str(content.connection)],
          ['Attempts', str(content.attempts)],
          ['Tries allowed', str(content.tries)],
          ['Error', str(content.error)]
        ])
      ]

    case EntryType.COMMAND:
      return [
        facts([
          ['Command', str(content.command)],
          ['Exit code', str(content.exitCode)],
          ['Arguments', joined(content.arguments)],
          ['Duration', ms(content.duration)]
        ])
      ]

    case EntryType.EVENT:
      return [facts([['Name', str(content.name)]]), block('Payload', content.payload)]

    default:
      return []
  }
}

/**
 * A panel with nothing in it is not drawn.
 *
 * The rule the TSX components each carried as their own early `return null`.
 * Doing it once here is what lets a renderer be a plain map: the bar does not
 * have to re-derive that an empty `Headers` table should be absent rather than
 * blank.
 */
function isWorthShowing(panel: Panel): boolean {
  switch (panel.kind) {
    case 'facts':
      return panel.rows.length > 0
    case 'mapping':
      return Object.keys(panel.value).length > 0
    case 'source':
      return panel.lines.length > 0
    case 'trace':
      return panel.frames.length > 0
    case 'block':
      return panel.value !== undefined
    case 'code':
      return panel.value !== ''
    case 'preview':
      return panel.html !== ''
  }
}

function facts(rows: Array<[string, string]>): Panel {
  return { kind: 'facts', rows: rows.filter(([, value]) => value !== '') }
}

function mapping(title: string, value: unknown): Panel {
  const record =
    value === null || typeof value !== 'object' || Array.isArray(value)
      ? {}
      : (value as Record<string, unknown>)

  return { kind: 'mapping', title, value: record }
}

function block(title: string, value: unknown): Panel {
  return {
    kind: 'block',
    title,
    value: value === undefined || value === null || value === '' ? undefined : value
  }
}

function code(title: string, value: string): Panel {
  return { kind: 'code', title, value }
}

function source(value: unknown, blame: number): Panel {
  const lines =
    value === null || typeof value !== 'object'
      ? []
      : Object.entries(value as Record<string, string>).map(([number, text]): [number, string] => [
          Number(number),
          text
        ])

  return { kind: 'source', lines, blame }
}

function trace(value: unknown): Panel {
  const frames = Array.isArray(value) ? value : []

  return {
    kind: 'trace',
    /**
     * Thirty, as the dashboard has always shown. A stack is a hundred frames
     * deep in a framework and the answer is never in the tail.
     */
    frames: frames.slice(0, 30).map((frame) => {
      const at = frame as { file?: unknown; line?: unknown }

      return { file: str(at.file), line: str(at.line) }
    })
  }
}

function preview(html: unknown): Panel {
  /**
   * `Purged By Lens` is what the mail watcher writes in place of a body it was
   * told not to keep. It is a sentinel, not a message worth previewing.
   */
  const usable = typeof html === 'string' && html !== '' && html !== 'Purged By Lens'

  return { kind: 'preview', html: usable ? html : '' }
}

function where(content: EntryContent): string {
  const file = str(content.file)

  return file === '' ? '' : `${file}:${str(content.line)}`
}

function ms(value: unknown): string {
  return value === undefined || value === null ? '' : `${str(value)}ms`
}

function bytes(value: unknown): string {
  return `${str(value)} bytes`
}

function joined(value: unknown): string {
  return Array.isArray(value) ? value.map(str).join(', ') : str(value)
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}
