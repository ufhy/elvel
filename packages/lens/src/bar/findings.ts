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
    ...missedTwice(entries),
    ...answeredBadly(entries),
    ...unrouted(entries),
    ...redirectWithoutTarget(entries),
    ...writesOnGet(entries),
    ...repeatedFailures(entries),
    ...failedJobs(entries),
    ...retriedJobs(entries),
    ...failedCalls(entries),
    ...repeatedCalls(entries),
    ...deniedGates(entries),
    ...failedCommands(entries),
    ...unaddressedMail(entries),
    ...dumpsLeftBehind(entries)
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

/** The request entry, which several of these read. */
function requestOf(entries: BarEntry[]): BarEntry | undefined {
  return entries.find((entry) => entry.type === 'request')
}

function of(entries: BarEntry[], type: string): BarEntry[] {
  return entries.filter((entry) => entry.type === type)
}

function one(
  id: string,
  level: Level,
  title: string,
  detail: string,
  evidence: BarEntry[]
): Finding[] {
  return [{ id, level, title, detail, evidence: evidence.map((entry) => entry.uuid) }]
}

/** The status the handler answered with, which is a finding on its own. */
function answeredBadly(entries: BarEntry[]): Finding[] {
  const request = requestOf(entries)
  const status = Number(request?.content.responseStatus ?? 0)

  if (request === undefined || status < 400) return []

  return one(
    'status',
    'problem',
    `The request answered ${status}`,
    status >= 500
      ? 'A server error: the handler did not finish what it was asked.'
      : 'The request was refused. The exception list says why, when one was thrown.',
    [request]
  )
}

/**
 * Nothing matched.
 *
 * A 404 from a missing route and a 404 the handler chose look identical in a log
 * and are different problems — the route field is what separates them.
 */
function unrouted(entries: BarEntry[]): Finding[] {
  const request = requestOf(entries)

  if (request === undefined) return []

  // Present and empty, not merely absent: the watcher always writes the key —
  // `null` when nothing matched — so an absent one is an entry from somewhere
  // that does not record routes at all, and says nothing either way.
  if (!('route' in request.content)) return []
  if (String(request.content.route ?? '') !== '') return []

  return one(
    'unrouted',
    'note',
    'No route matched this request',
    `${String(request.content.method ?? '')} ${String(request.content.uri ?? '')} was answered without a named route.`,
    [request]
  )
}

/** A 3xx the browser cannot follow. */
function redirectWithoutTarget(entries: BarEntry[]): Finding[] {
  const request = requestOf(entries)
  const status = Number(request?.content.responseStatus ?? 0)

  if (request === undefined || status < 300 || status >= 400) return []
  if (request.content.location !== null && request.content.location !== undefined) return []

  return one(
    'redirect-nowhere',
    'problem',
    `A ${status} with no location header`,
    'The browser is told to go somewhere else and not where.',
    [request]
  )
}

/**
 * A write on a GET.
 *
 * A GET is supposed to be safe to repeat — a prefetch, a crawler, a retry — and
 * one that writes is the shape behind a surprising number of duplicated rows.
 */
function writesOnGet(entries: BarEntry[]): Finding[] {
  const request = requestOf(entries)

  if (String(request?.content.method ?? '').toUpperCase() !== 'GET') return []

  const writes = of(entries, 'query').filter((entry) =>
    /^\s*(insert|update|delete|replace|truncate|drop|alter|create)\b/i.test(
      String(entry.content.sql ?? '')
    )
  )

  if (writes.length === 0) return []

  return one(
    'write-on-get',
    'problem',
    `${writes.length} write statement${writes.length === 1 ? '' : 's'} on a GET`,
    writes.map((entry) => shorten(String(entry.content.sql ?? ''))).join(' · '),
    writes
  )
}

/** The same failure twice in one request is a loop, not an incident. */
function repeatedFailures(entries: BarEntry[]): Finding[] {
  const byClass = new Map<string, BarEntry[]>()

  for (const entry of of(entries, 'exception')) {
    const name = String(entry.content.class ?? '')

    byClass.set(name, [...(byClass.get(name) ?? []), entry])
  }

  return [...byClass.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({
      id: `repeated-exception:${name}`,
      level: 'problem' as const,
      title: `${name} thrown ${group.length} times in one request`,
      detail: 'The same failure more than once is a loop around it, not one incident.',
      evidence: group.map((entry) => entry.uuid)
    }))
}

function failedJobs(entries: BarEntry[]): Finding[] {
  const failed = of(entries, 'job').filter((entry) => entry.content.status === 'failed')

  if (failed.length === 0) return []

  return one(
    'failed-jobs',
    'problem',
    `${failed.length} job${failed.length === 1 ? '' : 's'} failed`,
    failed
      .map((entry) => `${String(entry.content.name ?? '')}: ${String(entry.content.error ?? '')}`)
      .join(' · '),
    failed
  )
}

/** A retry that succeeded still failed once, and nothing else would say so. */
function retriedJobs(entries: BarEntry[]): Finding[] {
  const retried = of(entries, 'job').filter(
    (entry) => entry.content.status !== 'failed' && Number(entry.content.attempts ?? 1) > 1
  )

  if (retried.length === 0) return []

  return one(
    'retried-jobs',
    'note',
    `${retried.length} job${retried.length === 1 ? '' : 's'} needed more than one attempt`,
    retried
      .map((entry) => `${String(entry.content.name ?? '')} × ${String(entry.content.attempts)}`)
      .join(' · '),
    retried
  )
}

function failedCalls(entries: BarEntry[]): Finding[] {
  const failed = of(entries, 'client_request').filter(
    (entry) => entry.content.failed === true || Number(entry.content.responseStatus ?? 0) >= 400
  )

  if (failed.length === 0) return []

  return one(
    'failed-calls',
    'problem',
    `${failed.length} outbound call${failed.length === 1 ? '' : 's'} failed`,
    failed
      .map((entry) => `${String(entry.content.responseStatus)} ${String(entry.content.uri ?? '')}`)
      .join(' · '),
    failed
  )
}

/** The N+1 of the network, and the one a database trace cannot show. */
function repeatedCalls(entries: BarEntry[]): Finding[] {
  const byUri = new Map<string, BarEntry[]>()

  for (const entry of of(entries, 'client_request')) {
    const uri = String(entry.content.uri ?? '')

    byUri.set(uri, [...(byUri.get(uri) ?? []), entry])
  }

  return [...byUri.entries()]
    .filter(([, group]) => group.length > 2)
    .map(([uri, group]) => ({
      id: `repeated-call:${uri}`,
      level: 'problem' as const,
      title: `${uri} called ${group.length} times`,
      detail: 'The same call in a loop — the N+1 of the network, and the slowest kind.',
      evidence: group.map((entry) => entry.uuid),
      cost: round(group.reduce((total, entry) => total + Number(entry.content.duration ?? 0), 0))
    }))
}

function deniedGates(entries: BarEntry[]): Finding[] {
  const denied = of(entries, 'gate').filter((entry) => entry.content.result === 'denied')

  if (denied.length === 0) return []

  return one(
    'denied',
    'note',
    `${denied.length} authorisation check${denied.length === 1 ? '' : 's'} denied`,
    denied.map((entry) => String(entry.content.ability ?? '')).join(' · '),
    denied
  )
}

function failedCommands(entries: BarEntry[]): Finding[] {
  const failed = of(entries, 'command').filter((entry) => Number(entry.content.exitCode ?? 0) !== 0)

  if (failed.length === 0) return []

  return one(
    'failed-commands',
    'problem',
    `${failed.length} command${failed.length === 1 ? '' : 's'} exited non-zero`,
    failed
      .map((entry) => `${String(entry.content.command ?? '')} → ${String(entry.content.exitCode)}`)
      .join(' · '),
    failed
  )
}

/** Mail with nobody to send it to, which fails silently on most transports. */
function unaddressedMail(entries: BarEntry[]): Finding[] {
  const empty = of(entries, 'mail').filter((entry) => {
    const to = entry.content.to
    const cc = entry.content.cc
    const bcc = entry.content.bcc

    return [to, cc, bcc].every((list) => !Array.isArray(list) || list.length === 0)
  })

  if (empty.length === 0) return []

  return one(
    'mail-unaddressed',
    'problem',
    `${empty.length} mail${empty.length === 1 ? '' : 's'} with no recipient`,
    empty.map((entry) => String(entry.content.subject ?? '(no subject)')).join(' · '),
    empty
  )
}

/** A dump is written to be read now. One in a recorded request was forgotten. */
function dumpsLeftBehind(entries: BarEntry[]): Finding[] {
  const dumps = of(entries, 'dump')

  if (dumps.length === 0) return []

  return one(
    'dumps',
    'note',
    `${dumps.length} dump${dumps.length === 1 ? '' : 's'} in this request`,
    'Debugging left in the code — a dump is written to be read once.',
    dumps
  )
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
