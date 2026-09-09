import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * A copy deep enough to mask into without touching what the handler still holds.
 *
 * `structuredClone` refuses a `File` or a stream, both of which turn up in a
 * parsed body, so this copies plain objects and arrays and leaves anything else
 * by reference — those are never the thing a dotted path descends into.
 */
function structuredCopy(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}

  for (const [key, held] of Object.entries(value)) {
    copy[key] =
      held !== null && typeof held === 'object' && !Array.isArray(held)
        ? structuredCopy(held as Record<string, unknown>)
        : held
  }

  return copy
}

/** Replace the value at a dotted path, if the whole path is there. */
function maskPath(target: Record<string, unknown>, path: string[]): void {
  const [head, ...rest] = path

  if (head === undefined) return

  if (rest.length === 0) {
    if (head in target) target[head] = '********'

    return
  }

  const next = target[head]

  if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
    maskPath(next as Record<string, unknown>, rest)
  }
}

/**
 * What `onAfterResponse` can actually tell us, rather than what would be tidy.
 *
 * There is no `Response` to pass here, which was the first shape this took and
 * it recorded nothing at all. Measured against Elysia 1.4.30: for a handler
 * returning a value, `context.response` **is that value** — the string
 * `'hello'`, the object `{ ok: true }` — and no `Response` exists yet. One
 * appears only when the handler built it itself, or when nothing matched and
 * Elysia answered 404. So status comes from `set.status` except when a real
 * `Response` overrides it, and response headers exist only in that same case.
 */
export type RequestFacts = {
  request: Request
  status: number
  /** Empty unless the handler returned a `Response` of its own. */
  responseHeaders?: Headers
  /** The handler's return value, before Elysia serialised it. */
  responseValue?: unknown
  /** Where a redirect points, when this is one. */
  location?: string
  /** The route pattern Elysia matched, when one did. */
  route?: string
  /** The parsed request body, as Elysia handed it to the handler. */
  body?: unknown
  duration: number
  ip?: string
  session?: Record<string, unknown>
}

/**
 * Records one entry per request — Telescope's `RequestWatcher`.
 *
 * Telescope listens for `RequestHandled`, which Laravel fires with request and
 * response in hand. Elvel dispatches nothing of the kind and a `Response` is
 * only reachable from `onAfterResponse`, so this is driven by `lensPlugin`
 * rather than by a subscription. The fields, the hiding and the response
 * treatment follow Telescope.
 *
 * Two of Telescope's fields are absent, both because the runtime cannot supply
 * them rather than by choice:
 *
 * - `memory`. `memory_get_peak_usage()` is per-request under PHP-FPM because the
 *   process *is* the request. Bun serves many at once, so a peak figure would
 *   describe the server while being labelled as this request's.
 * - `middleware`. Elysia's hook chain is not enumerable per matched route the
 *   way `$route->gatherMiddleware()` is.
 */
export class RequestWatcher extends Watcher {
  register(_app: ApplicationContract): void {
    // Driven by `lensPlugin`; there is no event to subscribe to.
  }

  record(lens: Recorder, facts: RequestFacts): void {
    if (!lens.recording()) return

    const hidden = lens.hidden()

    const method = facts.request.method

    if (this.ignoredMethods().includes(method.toLowerCase())) return
    if (this.option<number[]>('ignoreStatusCodes', []).includes(facts.status)) return

    const url = new URL(facts.request.url)

    lens.record(
      EntryType.REQUEST,
      IncomingEntry.make({
        ipAddress: facts.ip ?? null,
        uri: `${url.pathname}${url.search}` || '/',
        method,
        route: facts.route ?? null,
        headers: this.headers(facts.request.headers, hidden.headers),
        payload: this.payload(url, facts.body, hidden.parameters),
        session: this.hide(facts.session ?? {}, hidden.parameters),
        responseHeaders:
          facts.responseHeaders === undefined
            ? {}
            : this.headers(facts.responseHeaders, hidden.headers),
        responseStatus: facts.status,
        response: this.response(facts, hidden.responseParameters),
        duration: Math.floor(facts.duration)
      })
    )
  }

  private ignoredMethods(): string[] {
    return this.option<string[]>('ignoreHttpMethods', []).map((method) => method.toLowerCase())
  }

  /**
   * Query string merged with the parsed body, the way `$request->input()` is.
   *
   * The body wins on a collision, which is Laravel's precedence.
   */
  private payload(url: URL, body: unknown, hidden: string[]): unknown {
    const query: Record<string, unknown> = {}

    for (const [key, value] of url.searchParams.entries()) query[key] = value

    if (typeof body === 'string') return body
    if (body === undefined || body === null) return this.hide(query, hidden)
    if (typeof body !== 'object') return this.hide(query, hidden)

    return this.hide({ ...query, ...(body as Record<string, unknown>) }, hidden)
  }

  /**
   * What the handler answered, following Telescope's ladder.
   *
   * Telescope reads `$response->getContent()`: JSON becomes an object, plain
   * text stays text, a redirect becomes a sentence, an empty body says so, and
   * anything else is recorded as the words `HTML Response` rather than a page of
   * markup nobody reads in a list. Over `size_limit` kilobytes it is replaced
   * wholesale, because the point of the limit is not to store the thing.
   */
  private response(facts: RequestFacts, hiddenKeys: string[]): unknown {
    const location = facts.location ?? facts.responseHeaders?.get('location') ?? undefined

    if (facts.status >= 300 && facts.status < 400 && location !== undefined) {
      return `Redirected to ${location}`
    }

    const value = facts.responseValue

    if (value === undefined || value === null || value === '') return 'Empty Response'

    if (typeof value === 'object') {
      return this.withinLimits(JSON.stringify(value) ?? '')
        ? this.hide(value as Record<string, unknown>, hiddenKeys)
        : 'Purged By Lens'
    }

    if (typeof value === 'string') {
      const type = facts.responseHeaders?.get('content-type') ?? 'text/plain'

      if (type.toLowerCase().startsWith('text/plain')) {
        return this.withinLimits(value) ? value : 'Purged By Lens'
      }

      return 'HTML Response'
    }

    return this.withinLimits(String(value)) ? value : 'Purged By Lens'
  }

  /** Telescope's arithmetic: whole kilobytes, at or under the limit. */
  private withinLimits(content: string): boolean {
    return Math.trunc(content.length / 1000) <= this.option('sizeLimit', 64)
  }

  /** Header values, with the hidden ones masked rather than dropped. */
  private headers(headers: Headers, hiddenNames: string[]): Record<string, string> {
    const hidden = new Set(hiddenNames.map((name) => name.toLowerCase()))
    const found: Record<string, string> = {}

    for (const [name, value] of headers.entries()) {
      found[name] = hidden.has(name.toLowerCase()) ? '********' : value
    }

    return found
  }

  /**
   * Mask the named keys, following a dotted path into nested objects.
   *
   * The dots matter and were missing at first. Telescope reaches these keys with
   * `Arr::get`/`Arr::set`, which walk `user.password` — so hiding a nested key
   * works there and silently did nothing here, which is worse than not offering
   * it: a payload of `{ user: { password } }` went into the row in full while
   * the configuration said it would not. Found by a review of the commit that
   * introduced it.
   *
   * One deliberate difference from Telescope remains: a key that is *present* is
   * masked, where Telescope masks only a truthy value, so a `password` of `'0'`
   * is recorded verbatim there. The difference is invisible in a dashboard and
   * the safer rule is the shorter one.
   */
  private hide(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const masked = structuredCopy(data)

    for (const key of keys) {
      maskPath(masked, key.split('.'))
    }

    return masked
  }
}
