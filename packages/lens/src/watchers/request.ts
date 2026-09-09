import type { ApplicationContract } from '@elvel/contracts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Headers hidden by default.
 *
 * Telescope's list is `['authorization', 'php-auth-pw']`; the second is a PHP
 * CGI variable with no counterpart. `cookie` is deliberately not added — it is
 * not on Telescope's list either, because that is what the published provider
 * stub is for, and `lens:install` publishes the same seam.
 */
export const HIDDEN_HEADERS = ['authorization']

/** Parameters hidden by default — Telescope's list, verbatim. */
export const HIDDEN_PARAMETERS = ['password', 'password_confirmation']

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
        headers: this.headers(facts.request.headers),
        payload: this.payload(url, facts.body),
        session: this.hide(facts.session ?? {}, HIDDEN_PARAMETERS),
        responseHeaders:
          facts.responseHeaders === undefined ? {} : this.headers(facts.responseHeaders),
        responseStatus: facts.status,
        response: this.response(facts),
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
  private payload(url: URL, body: unknown): unknown {
    const query: Record<string, unknown> = {}

    for (const [key, value] of url.searchParams.entries()) query[key] = value

    if (typeof body === 'string') return body
    if (body === undefined || body === null) return this.hide(query, HIDDEN_PARAMETERS)
    if (typeof body !== 'object') return this.hide(query, HIDDEN_PARAMETERS)

    return this.hide({ ...query, ...(body as Record<string, unknown>) }, HIDDEN_PARAMETERS)
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
  private response(facts: RequestFacts): unknown {
    const location = facts.location ?? facts.responseHeaders?.get('location') ?? undefined

    if (facts.status >= 300 && facts.status < 400 && location !== undefined) {
      return `Redirected to ${location}`
    }

    const value = facts.responseValue

    if (value === undefined || value === null || value === '') return 'Empty Response'

    if (typeof value === 'object') {
      return this.withinLimits(JSON.stringify(value) ?? '')
        ? this.hide(value as Record<string, unknown>, this.hiddenResponseKeys())
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

  private hiddenResponseKeys(): string[] {
    return this.option<string[]>('hiddenResponseParameters', [])
  }

  /** Telescope's arithmetic: whole kilobytes, at or under the limit. */
  private withinLimits(content: string): boolean {
    return Math.trunc(content.length / 1000) <= this.option('sizeLimit', 64)
  }

  /** Header values, with the hidden ones masked rather than dropped. */
  private headers(headers: Headers): Record<string, string> {
    const hidden = new Set(HIDDEN_HEADERS.map((name) => name.toLowerCase()))
    const found: Record<string, string> = {}

    for (const [name, value] of headers.entries()) {
      found[name] = hidden.has(name.toLowerCase()) ? '********' : value
    }

    return found
  }

  /**
   * Mask a key that is present, whatever it holds.
   *
   * Telescope masks only a *truthy* value — `if (Arr::get($data, $parameter))` —
   * so a `password` of `'0'` is recorded as `'0'`. Deliberately not copied: the
   * difference is invisible in a dashboard and the safer rule is shorter.
   */
  private hide(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const masked: Record<string, unknown> = { ...data }

    for (const key of keys) {
      if (key in masked) masked[key] = '********'
    }

    return masked
  }
}
