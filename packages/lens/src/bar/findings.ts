import { CACHE_MISSED } from '../watchers/cache.ts'
import type { BarEntry } from './ring.ts'

export type Level = 'problem' | 'note'

/**
 * Something worth saying about a unit of work, said without being asked.
 *
 * The difference between this file and the rest of the package is the difference
 * between a tool that records and a tool that reads: a list of forty queries is
 * data, "the same statement ran thirty-nine times from ArticleList.tsx:22" is an
 * answer. Telescope, Debugbar and Clockwork all show the first and leave the
 * second to you.
 */
export type Finding = {
  /** Stable across requests, so the client can keep one expanded. */
  id: string
  level: Level
  /** One sentence, stating the problem. No hedging, no "consider". */
  title: string
  /** The evidence in words — a number, a name, a place. */
  detail: string
  /** Entries that prove it, for the evidence pane. */
  evidence: string[]
  /** Milliseconds this accounts for, when that is meaningful. */
  cost?: number
}

export type Thresholds = {
  /** Milliseconds at or above which one query is called out on its own. */
  slowQuery: number
  /** How many identical statements before it is an N+1 rather than a coincidence. */
  repeats: number
  /** Bytes of response body worth mentioning. */
  responseBytes: number
  /** Milliseconds a single view render may take. */
  viewMs: number
  /** Share of the request spent in the database before it is the story. */
  databaseShare: number
}

export const DEFAULTS: Thresholds = {
  slowQuery: 100,
  repeats: 3,
  responseBytes: 256 * 1024,
  viewMs: 100,
  databaseShare: 0.5
}

/** Where a request's time went, as three numbers rather than one. */
export type Split = {
  totalMs: number
  databaseMs: number
  renderMs: number
  /** What is left: the application's own work. */
  otherMs: number
  queries: number
}

export function split(entries: BarEntry[], totalMs: number): Split {
  const databaseMs = sum(entries, 'query', 'time')
  const renderMs = sum(entries, 'view', 'time')

  return {
    totalMs,
    databaseMs: round(databaseMs),
    renderMs: round(renderMs),
    otherMs: round(Math.max(0, totalMs - databaseMs - renderMs)),
    queries: entries.filter((entry) => entry.type === 'query').length
  }
}

/**
 * Everything worth saying about one unit of work.
 *
 * Ordered by how much of the request each accounts for, so the first line is the
 * one to act on. A finding with no cost sorts under those that have one — a
 * swallowed exception matters, but not before the four hundred milliseconds.
 */
export function findings(
  entries: BarEntry[],
  shape: Split,
  thresholds: Thresholds = DEFAULTS
): Finding[] {
  const found = [
    ...repeated(entries, thresholds),
    ...slowQueries(entries, thresholds),
    ...databaseBound(entries, shape, thresholds),
    ...heavyResponse(entries, thresholds),
    ...slowViews(entries, thresholds),
    ...swallowed(entries),
    ...errorsLogged(entries),
    ...missedTwice(entries)
  ]

  return found.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
}

/**
 * The N+1, named rather than badged.
 *
 * Grouped by the statement itself, which is the recorder's own family hash made
 * visible: the placeholders are still in it, so a thousand reads of one row by
 * differing id are one group. The caller is what makes it actionable — a count
 * tells you there is a loop, `file:line` tells you which.
 */
function repeated(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const groups = new Map<string, BarEntry[]>()

  for (const entry of entries) {
    if (entry.type !== 'query') continue

    const sql = String(entry.content.sql ?? '')

    if (sql === '') continue

    groups.set(sql, [...(groups.get(sql) ?? []), entry])
  }

  const found: Finding[] = []

  for (const [sql, group] of groups) {
    if (group.length < thresholds.repeats) continue

    const first = group[0]

    if (first === undefined) continue

    const where = place(first)
    const cost = round(group.reduce((total, entry) => total + Number(entry.content.time ?? 0), 0))

    found.push({
      id: `repeat:${sql}`,
      level: 'problem',
      title: `The same query ran ${group.length} times`,
      detail: where === '' ? shorten(sql) : `${shorten(sql)} — from ${where}`,
      evidence: group.map((entry) => entry.uuid),
      cost
    })
  }

  return found
}

function slowQueries(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  return entries
    .filter(
      (entry) => entry.type === 'query' && Number(entry.content.time ?? 0) >= thresholds.slowQuery
    )
    .map((entry) => ({
      id: `slow:${entry.uuid}`,
      level: 'problem' as const,
      title: `A query took ${round(Number(entry.content.time))}ms`,
      detail: `${shorten(String(entry.content.sql ?? ''))}${place(entry) === '' ? '' : ` — from ${place(entry)}`}`,
      evidence: [entry.uuid],
      cost: round(Number(entry.content.time))
    }))
}

/**
 * The shape of the request, when the shape is the problem.
 *
 * Said only when no single query is to blame — otherwise it repeats what the
 * line above already said, and a bar that says the same thing twice is a bar
 * people stop reading.
 */
function databaseBound(entries: BarEntry[], shape: Split, thresholds: Thresholds): Finding[] {
  if (shape.totalMs <= 0 || shape.queries < 2) return []
  if (shape.databaseMs / shape.totalMs < thresholds.databaseShare) return []
  if (entries.some((entry) => Number(entry.content.time ?? 0) >= thresholds.slowQuery)) return []

  const share = Math.round((shape.databaseMs / shape.totalMs) * 100)

  return [
    {
      id: 'database-bound',
      level: 'note',
      title: `${share}% of this request was the database`,
      detail: `${shape.queries} queries, ${shape.databaseMs}ms of ${shape.totalMs}ms.`,
      evidence: entries.filter((entry) => entry.type === 'query').map((entry) => entry.uuid),
      cost: shape.databaseMs
    }
  ]
}

function heavyResponse(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const request = entries.find((entry) => entry.type === 'request')

  if (request === undefined) return []

  const body = request.content.response
  const size = typeof body === 'string' ? body.length : 0

  if (size < thresholds.responseBytes) return []

  return [
    {
      id: 'heavy-response',
      level: 'note',
      title: `The response was ${kb(size)}`,
      detail: 'Large enough that the browser will feel it before your server does.',
      evidence: [request.uuid]
    }
  ]
}

function slowViews(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  return entries
    .filter(
      (entry) => entry.type === 'view' && Number(entry.content.time ?? 0) >= thresholds.viewMs
    )
    .map((entry) => ({
      id: `view:${entry.uuid}`,
      level: 'note' as const,
      title: `${String(entry.content.view)} took ${round(Number(entry.content.time))}ms to render`,
      detail: `${kb(Number(entry.content.size ?? 0))} of markup.`,
      evidence: [entry.uuid],
      cost: round(Number(entry.content.time))
    }))
}

/**
 * An exception that never reached the client.
 *
 * The most valuable thing on this list and the one no list of entries shows:
 * something threw, something caught it, and the page came back 200. It is
 * invisible in the browser, invisible in the log if nobody looked, and it is
 * exactly what a person is hunting when they open an inspector.
 */
function swallowed(entries: BarEntry[]): Finding[] {
  const request = entries.find((entry) => entry.type === 'request')
  const status = Number(request?.content.responseStatus ?? 0)
  const thrown = entries.filter((entry) => entry.type === 'exception')

  if (thrown.length === 0 || status >= 400) return []

  return [
    {
      id: 'swallowed',
      level: 'problem',
      title: `${thrown.length} exception${thrown.length === 1 ? '' : 's'} thrown, and the page still answered ${status}`,
      detail: thrown
        .map((entry) => `${String(entry.content.class)}: ${String(entry.content.message)}`)
        .join(' · '),
      evidence: thrown.map((entry) => entry.uuid)
    }
  ]
}

function errorsLogged(entries: BarEntry[]): Finding[] {
  const bad = entries.filter(
    (entry) =>
      entry.type === 'log' &&
      ['error', 'critical', 'alert', 'emergency'].includes(String(entry.content.level ?? ''))
  )

  if (bad.length === 0) return []

  return [
    {
      id: 'logged-errors',
      level: 'problem',
      title: `${bad.length} error-level log message${bad.length === 1 ? '' : 's'}`,
      detail: bad.map((entry) => String(entry.content.message)).join(' · '),
      evidence: bad.map((entry) => entry.uuid)
    }
  ]
}

/**
 * A key looked up twice and missed twice.
 *
 * Not a slow request on its own, but it is a cache that is not caching, which is
 * a bug wearing the costume of a working feature.
 */
function missedTwice(entries: BarEntry[]): Finding[] {
  const misses = new Map<string, BarEntry[]>()

  for (const entry of entries) {
    if (entry.type !== 'cache' || entry.content.type !== CACHE_MISSED) continue

    const key = String(entry.content.key ?? '')

    misses.set(key, [...(misses.get(key) ?? []), entry])
  }

  return [...misses.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      id: `miss:${key}`,
      level: 'note' as const,
      title: `Cache key ${key} missed ${group.length} times`,
      detail: 'Looked up more than once and never found — nothing is writing it.',
      evidence: group.map((entry) => entry.uuid)
    }))
}

function place(entry: BarEntry): string {
  const file = entry.content.file

  return file === undefined || file === null ? '' : `${String(file)}:${String(entry.content.line)}`
}

function shorten(sql: string): string {
  return sql.length <= 90 ? sql : `${sql.slice(0, 89)}…`
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`
}

function sum(entries: BarEntry[], type: string, key: string): number {
  return entries
    .filter((entry) => entry.type === type)
    .reduce((total, entry) => total + Number(entry.content[key] ?? 0), 0)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
