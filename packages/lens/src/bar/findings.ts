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
  /** Log lines in one request before the log is noise rather than a record. */
  logLines: number
  /** Events in one request before the list is a haystack. */
  events: number
  /** Bytes of markup one view may produce. */
  viewBytes: number
  /** Bytes an outbound response may carry before it is worth saying. */
  callBytes: number
  /** Bytes a single cached value may hold. */
  cacheBytes: number
  /** Seconds below which a cache entry expires too soon to have been read. */
  cacheSeconds: number
  /** How many times a route's own median before the request is slow *for it*. */
  slowerThanUsual: number
  /** Share of a request that may go to middleware before the handler. */
  middlewareShare: number
  /** Share of a profile that may be the framework's own code. */
  frameworkShare: number
  /** Bytes of request body worth mentioning. */
  payloadBytes: number
  /** Attachments on one mail before it is worth saying. */
  attachments: number
  /** Cache lookups before a miss rate is a verdict rather than a coincidence. */
  cacheLookups: number
  /** Share of cache lookups that may miss before the cache is not caching. */
  missShare: number
}

/**
 * The numbers, in one place and all arguable.
 *
 * Each is a judgement rather than a measurement, so each is here to be changed
 * rather than buried in the check that reads it. What they have in common: they
 * are set where a developer would already have raised an eyebrow, not where
 * something is formally wrong.
 */
export const DEFAULTS: Thresholds = {
  slowQuery: 100,
  repeats: 3,
  responseBytes: 256 * 1024,
  viewMs: 100,
  databaseShare: 0.5,
  logLines: 20,
  events: 30,
  viewBytes: 512 * 1024,
  callBytes: 1024 * 1024,
  cacheBytes: 128 * 1024,
  cacheSeconds: 2,
  slowerThanUsual: 2,
  middlewareShare: 0.5,
  frameworkShare: 0.7,
  payloadBytes: 256 * 1024,
  attachments: 5,
  cacheLookups: 5,
  missShare: 0.8
}

/**
 * What the batch knows about itself, beyond its entries.
 *
 * Three of these answer questions no entry can: whether the request was slow
 * *for this route*, whether the time went somewhere before the handler, and
 * whose code the profiler actually caught.
 */
export type BatchFacts = {
  verdict?: { route: string; medianMs: number; samples: number; times?: number }
  marks?: Array<{ name: string; atMs: number }>
  profile?: {
    durationMs: number
    outsideMs: number
    origins: Array<{ name: string; selfMs: number; mine: boolean }>
  }
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
  thresholds: Thresholds = DEFAULTS,
  batch: BatchFacts = {}
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
    ...dumpsLeftBehind(entries),
    ...failedNotifications(entries),
    ...failedTasks(entries),
    ...noisyLog(entries, thresholds),
    ...manyEvents(entries, thresholds),
    ...heavyViews(entries, thresholds),
    ...repeatedViews(entries, thresholds),
    ...repeatedAbilities(entries, thresholds),
    ...heavyCalls(entries, thresholds),
    ...heavyCacheValues(entries, thresholds),
    ...shortCacheLives(entries, thresholds),
    ...heavyPayload(entries, thresholds),
    ...mostlyMisses(entries, thresholds),
    ...mailInTheRequest(entries, thresholds),
    ...failedBatches(entries),
    ...slowerThanUsual(batch, thresholds),
    ...timeBeforeTheHandler(batch, shape, thresholds),
    ...frameworkBound(batch, thresholds)
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

/** A notification that did not arrive is a support question nobody can answer. */
function failedNotifications(entries: BarEntry[]): Finding[] {
  const failed = of(entries, 'notification').filter((entry) => entry.content.outcome === 'failed')

  if (failed.length === 0) return []

  return one(
    'failed-notifications',
    'problem',
    `${failed.length} notification${failed.length === 1 ? '' : 's'} failed`,
    failed
      .map(
        (entry) =>
          `${String(entry.content.notification ?? '')} over ${String(entry.content.channel ?? '')}: ${String(entry.content.error ?? '')}`
      )
      .join(' · '),
    failed
  )
}

/**
 * A task that failed, and one that never ran because the last had not finished.
 *
 * Kept apart on purpose: "it ran and failed" and "it did not run" send people
 * looking in different places, and a recorder that shows only the first sends
 * them to the wrong one.
 */
function failedTasks(entries: BarEntry[]): Finding[] {
  const tasks = of(entries, 'schedule')
  const failed = tasks.filter((entry) => entry.content.outcome === 'failed')
  const overlapping = tasks.filter((entry) => entry.content.outcome === 'overlapping')

  return [
    ...(failed.length === 0
      ? []
      : one(
          'failed-tasks',
          'problem',
          `${failed.length} scheduled task${failed.length === 1 ? '' : 's'} failed`,
          failed
            .map(
              (entry) => `${String(entry.content.task ?? '')}: ${String(entry.content.error ?? '')}`
            )
            .join(' · '),
          failed
        )),
    ...(overlapping.length === 0
      ? []
      : one(
          'overlapping-tasks',
          'note',
          `${overlapping.length} scheduled task${overlapping.length === 1 ? '' : 's'} skipped, still running from last time`,
          'The previous run had not finished. Either it is slower than its schedule, or it is stuck.',
          overlapping
        ))
  ]
}

/** A log nobody can read is a log nobody reads. */
function noisyLog(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const lines = of(entries, 'log')

  if (lines.length < thresholds.logLines) return []

  return one(
    'log-noise',
    'note',
    `${lines.length} log lines in one request`,
    'A record this long is read by nobody. Raise the level, or drop the ones that say nothing.',
    lines
  )
}

function manyEvents(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const fired = of(entries, 'event')

  if (fired.length < thresholds.events) return []

  return one(
    'many-events',
    'note',
    `${fired.length} events in one request`,
    'Every listener runs inside the request, so this is work the caller waited for.',
    fired
  )
}

function heavyViews(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const heavy = of(entries, 'view').filter(
    (entry) => Number(entry.content.size ?? 0) >= thresholds.viewBytes
  )

  if (heavy.length === 0) return []

  return one(
    'heavy-view',
    'note',
    `${heavy.length} view${heavy.length === 1 ? '' : 's'} produced more than ${kb(thresholds.viewBytes)}`,
    heavy
      .map(
        (entry) => `${String(entry.content.view ?? '')} · ${kb(Number(entry.content.size ?? 0))}`
      )
      .join(' · '),
    heavy
  )
}

/** One component rendered in a loop, which a render count makes obvious. */
function repeatedViews(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const byName = new Map<string, BarEntry[]>()

  for (const entry of of(entries, 'view')) {
    const view = String(entry.content.view ?? '')

    byName.set(view, [...(byName.get(view) ?? []), entry])
  }

  return [...byName.entries()]
    .filter(([, group]) => group.length >= thresholds.repeats * 5)
    .map(([view, group]) => ({
      id: `repeated-view:${view}`,
      level: 'note' as const,
      title: `${view} rendered ${group.length} times`,
      detail: 'A component in a loop. Cheap each time is not cheap this many times.',
      evidence: group.map((entry) => entry.uuid),
      cost: round(group.reduce((total, entry) => total + Number(entry.content.time ?? 0), 0))
    }))
}

/** The same question asked of the gate over and over, usually inside a list. */
function repeatedAbilities(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const byAbility = new Map<string, BarEntry[]>()

  for (const entry of of(entries, 'gate')) {
    const ability = String(entry.content.ability ?? '')

    byAbility.set(ability, [...(byAbility.get(ability) ?? []), entry])
  }

  return [...byAbility.entries()]
    .filter(([, group]) => group.length >= thresholds.repeats * 5)
    .map(([ability, group]) => ({
      id: `repeated-gate:${ability}`,
      level: 'note' as const,
      title: `${ability} checked ${group.length} times`,
      detail: 'A policy inside a loop. One check before the loop is usually the same answer.',
      evidence: group.map((entry) => entry.uuid)
    }))
}

function heavyCalls(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const heavy = of(entries, 'client_request').filter(
    (entry) => Number(entry.content.responseSize ?? 0) >= thresholds.callBytes
  )

  if (heavy.length === 0) return []

  return one(
    'heavy-call',
    'note',
    `${heavy.length} outbound response${heavy.length === 1 ? '' : 's'} over ${kb(thresholds.callBytes)}`,
    heavy
      .map(
        (entry) =>
          `${String(entry.content.uri ?? '')} · ${kb(Number(entry.content.responseSize ?? 0))}`
      )
      .join(' · '),
    heavy
  )
}

function heavyCacheValues(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const heavy = of(entries, 'cache').filter(
    (entry) => entry.content.type === 'set' && sizeOf(entry.content.value) >= thresholds.cacheBytes
  )

  if (heavy.length === 0) return []

  return one(
    'heavy-cache',
    'note',
    `${heavy.length} cached value${heavy.length === 1 ? '' : 's'} over ${kb(thresholds.cacheBytes)}`,
    heavy
      .map((entry) => `${String(entry.content.key ?? '')} · ${kb(sizeOf(entry.content.value))}`)
      .join(' · '),
    heavy
  )
}

/**
 * A cache that expires before anybody could have used it.
 *
 * A second or two is a write, a read and nothing else: the entry costs the round
 * trip to store it and is gone before the next request asks.
 */
function shortCacheLives(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const brief = of(entries, 'cache').filter((entry) => {
    if (entry.content.type !== 'set') return false

    const seconds = Number(entry.content.expiration ?? 0)

    return seconds > 0 && seconds <= thresholds.cacheSeconds
  })

  if (brief.length === 0) return []

  return one(
    'brief-cache',
    'note',
    `${brief.length} cache entr${brief.length === 1 ? 'y' : 'ies'} expire within ${thresholds.cacheSeconds}s`,
    brief
      .map((entry) => `${String(entry.content.key ?? '')} · ${String(entry.content.expiration)}s`)
      .join(' · '),
    brief
  )
}

/**
 * Slow for *this route*, which is the only kind of slow worth interrupting for.
 *
 * 400ms is fine for a report and alarming for a redirect, and a fixed threshold
 * cannot tell them apart. The median of this route's own recent history can.
 */
function slowerThanUsual(batch: BatchFacts, thresholds: Thresholds): Finding[] {
  const verdict = batch.verdict

  if (verdict?.times === undefined || verdict.times < thresholds.slowerThanUsual) return []

  return [
    {
      id: 'slower-than-usual',
      level: 'problem',
      title: `${verdict.times.toFixed(1)}× slower than this route usually is`,
      detail: `${verdict.route} normally takes about ${round(verdict.medianMs)}ms, over ${verdict.samples} recent requests.`,
      evidence: []
    }
  ]
}

/**
 * The time went before the handler ever ran.
 *
 * `marks` is what the framework was doing between the things a watcher records,
 * and a request that spent most of itself in middleware is a different problem
 * from a slow handler — usually a session store, an authentication round trip,
 * or a rate limiter reaching for a cache that is not there.
 */
function timeBeforeTheHandler(batch: BatchFacts, shape: Split, thresholds: Thresholds): Finding[] {
  const marks = batch.marks ?? []
  const handler = marks.find((mark) => mark.name === 'handler')

  if (handler === undefined || shape.totalMs <= 0) return []

  const share = handler.atMs / shape.totalMs

  if (share < thresholds.middlewareShare) return []

  return [
    {
      id: 'before-the-handler',
      level: 'problem',
      title: `${Math.round(share * 100)}% of the request was over before the handler ran`,
      detail: `${round(handler.atMs)}ms of ${round(shape.totalMs)}ms went to middleware — the session, authentication, or a limiter.`,
      evidence: [],
      cost: round(handler.atMs)
    }
  ]
}

/**
 * The profiler caught the framework rather than the application.
 *
 * Read only when a profile was armed, and reported as a note: it is the one
 * finding here that is as likely to be about this framework as about the code
 * using it.
 */
function frameworkBound(batch: BatchFacts, thresholds: Thresholds): Finding[] {
  const profile = batch.profile

  if (profile === undefined) return []

  const measured = profile.origins.reduce((total, origin) => total + origin.selfMs, 0)

  if (measured <= 0) return []

  const theirs = profile.origins
    .filter((origin) => !origin.mine)
    .reduce((total, origin) => total + origin.selfMs, 0)

  const share = theirs / measured

  if (share < thresholds.frameworkShare) return []

  const worst = [...profile.origins]
    .filter((origin) => !origin.mine)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 3)
    .map((origin) => `${origin.name} ${round(origin.selfMs)}ms`)
    .join(' · ')

  return [
    {
      id: 'framework-bound',
      level: 'note',
      title: `${Math.round(share * 100)}% of the profile was not your code`,
      detail: worst === '' ? 'The time is in the framework, not in the application.' : worst,
      evidence: [],
      cost: round(theirs)
    }
  ]
}

function heavyPayload(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const request = requestOf(entries)
  const size = sizeOf(request?.content.payload)

  if (request === undefined || size < thresholds.payloadBytes) return []

  return one(
    'heavy-payload',
    'note',
    `The request body was ${kb(size)}`,
    'Recorded in full, which is also what the application parsed before the handler ran.',
    [request]
  )
}

/**
 * A cache that mostly misses is not caching.
 *
 * Counted rather than per-key: `missedTwice` catches one key nothing writes,
 * and this catches the store that is cold for everything — a cache pointed at
 * the wrong connection, or one whose entries expire before they are read.
 */
function mostlyMisses(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const lookups = of(entries, 'cache').filter(
    (entry) => entry.content.type === 'hit' || entry.content.type === CACHE_MISSED
  )

  if (lookups.length < thresholds.cacheLookups) return []

  const missed = lookups.filter((entry) => entry.content.type === CACHE_MISSED)
  const share = missed.length / lookups.length

  if (share < thresholds.missShare) return []

  return one(
    'cache-cold',
    'problem',
    `${missed.length} of ${lookups.length} cache lookups missed`,
    'A cache this cold is costing a round trip and saving nothing.',
    missed
  )
}

/**
 * Several mails sent while somebody waited for the page.
 *
 * The transport is somebody else's server, and a request that waits for it has
 * given its own latency away. **From two**, because one transactional mail — a
 * password reset, a receipt — is ordinary and flagging every one of them would
 * make this list noise. Two in one request is a loop or a fan-out, and both
 * belong on the queue.
 */
function mailInTheRequest(entries: BarEntry[], thresholds: Thresholds): Finding[] {
  const request = requestOf(entries)
  const sent = of(entries, 'mail')

  if (request === undefined || sent.length < 2) return []

  const heavy = sent.filter(
    (entry) => Number(entry.content.attachments ?? 0) >= thresholds.attachments
  )

  return [
    ...one(
      'mail-in-request',
      'note',
      `${sent.length} mails sent while the request was open`,
      "The caller waited for somebody else's SMTP server. Queue it and they will not.",
      sent
    ),
    ...(heavy.length === 0
      ? []
      : one(
          'mail-attachments',
          'note',
          `${heavy.length} mail${heavy.length === 1 ? '' : 's'} carried ${thresholds.attachments} attachments or more`,
          heavy
            .map(
              (entry) =>
                `${String(entry.content.subject ?? '(no subject)')} · ${String(entry.content.attachments)}`
            )
            .join(' · '),
          heavy
        ))
  ]
}

/** A batch whose jobs did not all arrive, read from the jobs beside it. */
function failedBatches(entries: BarEntry[]): Finding[] {
  const batches = of(entries, 'batch')
  const failed = of(entries, 'job').filter((entry) => entry.content.status === 'failed')

  if (batches.length === 0 || failed.length === 0) return []

  return one(
    'failed-batch',
    'problem',
    `${failed.length} job${failed.length === 1 ? '' : 's'} failed in a batch of ${batches.map((entry) => String(entry.content.totalJobs ?? 0)).join(', ')}`,
    'A batch reports its own success; the jobs inside it are where the failure is.',
    [...batches, ...failed]
  )
}

/** Bytes a recorded value takes as JSON, which is how it was stored. */
function sizeOf(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return value.length

  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    // A cycle, which the watcher would have summarised anyway.
    return 0
  }
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
