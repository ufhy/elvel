import { EntryType, type EntryTypeName } from '../../entry-type.ts'

/**
 * The vocabulary the dashboard is drawn from, read off Telescope's own styles.
 *
 * Not invented here: the palette is the one in `resources/sass/_colors.scss`,
 * the badge colours are `mixins/entriesStyles.js`, and the sidebar order and
 * labels are `views/layout.blade.php`. The first version of these screens was a
 * plain table because none of that had been looked at.
 */

/** Telescope's five badge tones, as semantic names. */
export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'secondary'

/** `requestStatusClass` — 2xx green, 3xx blue, 4xx amber, 5xx red. */
export function statusTone(status: number): Tone {
  if (!status) return 'danger'
  if (status < 300) return 'success'
  if (status < 400) return 'info'
  if (status < 500) return 'warning'

  return 'danger'
}

/** `requestMethodClass` — reads muted, writes blue, deletes red. */
export function methodTone(method: string): Tone {
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') return 'info'
  if (method === 'DELETE') return 'danger'

  return 'secondary'
}

/**
 * "3 minutes ago", with the timestamp kept for the title attribute.
 *
 * Telescope shows relative time in the list and the exact time on hover, and it
 * is the right way round: a list is scanned for "just now" and "yesterday", not
 * read for a clock reading.
 */
export function timeAgo(value: string | undefined, now: Date = new Date()): string {
  if (value === undefined) return ''

  const then = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)

  if (Number.isNaN(then)) return value

  const seconds = Math.round((now.getTime() - then) / 1000)

  if (seconds < 0) return 'just now'
  if (seconds < 45) return 'just now'

  for (const [limit, size, unit] of [
    [3600, 60, 'minute'],
    [86_400, 3600, 'hour'],
    [2_592_000, 86_400, 'day'],
    [31_536_000, 2_592_000, 'month']
  ] as Array<[number, number, string]>) {
    if (seconds < limit) {
      const count = Math.round(seconds / size)

      return `${count} ${unit}${count === 1 ? '' : 's'} ago`
    }
  }

  const years = Math.round(seconds / 31_536_000)

  return `${years} year${years === 1 ? '' : 's'} ago`
}

/** Sidebar sections, in Telescope's order — not alphabetical, and not by accident. */
export const SECTIONS: Array<{ types: EntryTypeName[] }> = [
  { types: [EntryType.REQUEST, EntryType.COMMAND, EntryType.SCHEDULED_TASK, EntryType.JOB] },
  {
    types: [
      EntryType.BATCH,
      EntryType.CACHE,
      EntryType.DUMP,
      EntryType.EVENT,
      EntryType.EXCEPTION,
      EntryType.GATE,
      EntryType.CLIENT_REQUEST,
      EntryType.LOG,
      EntryType.MAIL,
      EntryType.MODEL,
      EntryType.NOTIFICATION,
      EntryType.QUERY,
      EntryType.REDIS,
      EntryType.VIEW
    ]
  }
]

/** What each type is called in the navigation — Telescope's own words. */
const LABELS: Record<EntryTypeName, string> = {
  [EntryType.BATCH]: 'Batches',
  [EntryType.CACHE]: 'Cache',
  [EntryType.CLIENT_REQUEST]: 'HTTP Client',
  [EntryType.COMMAND]: 'Commands',
  [EntryType.DUMP]: 'Dumps',
  [EntryType.EVENT]: 'Events',
  [EntryType.EXCEPTION]: 'Exceptions',
  [EntryType.GATE]: 'Gates',
  [EntryType.JOB]: 'Jobs',
  [EntryType.LOG]: 'Logs',
  [EntryType.MAIL]: 'Mail',
  [EntryType.MODEL]: 'Models',
  [EntryType.NOTIFICATION]: 'Notifications',
  [EntryType.QUERY]: 'Queries',
  [EntryType.REDIS]: 'Redis',
  [EntryType.REQUEST]: 'Requests',
  [EntryType.SCHEDULED_TASK]: 'Schedule',
  [EntryType.VIEW]: 'Views'
}

export function labelFor(type: EntryTypeName): string {
  return LABELS[type]
}
