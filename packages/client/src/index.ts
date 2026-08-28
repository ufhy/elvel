/**
 * Everything the browser needs to talk to the server, decided once.
 *
 * Imports nothing. This file runs in the browser and must stay that way: a single
 * import from the server half would pull the framework into the bundle, and the
 * bundler would be right to.
 *
 * It holds no Vue, no React and no Svelte either. What a component needs from here
 * is a payload and a function that returns JSON.
 */

/** A validation failure, carrying the server's per-field messages. */
export class Invalid extends Error {
  /**
   * Declared and assigned, not a parameter property.
   *
   * The Vite templates turn on `erasableSyntaxOnly`, which refuses syntax that
   * emits code rather than only describing types — and `constructor(readonly x)`
   * emits an assignment. Measured as `TS1294`.
   */
  readonly errors: Record<string, string[]>

  constructor(message: string, errors: Record<string, string[]>) {
    super(message)
    this.name = 'Invalid'
    this.errors = errors
  }
}

/** The session is gone. A router turns this into a trip to the sign-in screen. */
export class Unauthenticated extends Error {
  constructor() {
    super('Signed out')
    this.name = 'Unauthenticated'
  }
}

/**
 * The session is real but the password has not been confirmed recently.
 *
 * A 423, and it is a different situation from a 401: the caller is who they say,
 * they simply have not proved it lately — and reading which devices are signed in,
 * or a two-factor secret, is where a borrowed unlocked browser does real damage.
 *
 * The useful response is **to load the page as a document**. The server has the
 * same guard on the document route, and answering it there redirects to the
 * confirmation screen *and* remembers where the person was going. A client that
 * navigated to the confirmation screen itself would arrive without that, and send
 * them somewhere else afterwards.
 */
export class NeedsPasswordConfirmation extends Error {
  constructor() {
    super('Password confirmation required')
    this.name = 'NeedsPasswordConfirmation'
  }
}

/**
 * What the server embedded in the document it rendered.
 *
 * Read from an inert `<script type="application/json">` rather than from a global
 * the server assigned: a JSON script tag is not executed, so nothing inside it can
 * define or overwrite anything on the page.
 *
 * Empty in shell mode, and empty on Vite's own dev origin — there is no document
 * there, so there is nothing to boot from. One address serves the application: the
 * server's.
 */
export function embedded<T = Record<string, unknown>>(): Partial<T> & { csrf?: string } {
  /**
   * No document is an answer, not a crash.
   *
   * This module is imported where there is no DOM — a test, a build script, and
   * server-side rendering, which is the one that matters: an SSR entry importing
   * this to reach `call()` would otherwise throw `document is not defined` at
   * import time, before anything had a chance to go wrong.
   */
  if (typeof document === 'undefined') return {} as Partial<T> & { csrf?: string }

  const tag = document.querySelector('#page-data')

  if (tag === null) return {} as Partial<T> & { csrf?: string }

  return JSON.parse(tag.textContent ?? '{}')
}

/**
 * The payload this page loaded with — the convenient way to read it.
 *
 * Captured at module evaluation, which is correct in a browser: one document per
 * page load. Empty everywhere else.
 */
export const page = embedded()

/**
 * What a query value may be, and what happens to each.
 *
 * `null` and `undefined` are dropped rather than sent as the strings `"null"` and
 * `"undefined"`, which is what `URLSearchParams` does with them unaided — and what
 * turns an absent filter into a filter for the word "undefined".
 *
 * An array repeats its key: `{ ids: [1, 2] }` is `?ids=1&ids=2`, and that is the one
 * shape the other end can read. Measured against a running application:
 *
 * | sent            | no schema           | `t.Array` on the route |
 * | `?ids=1&ids=2`  | `{ ids: '2' }`      | `{ ids: ['1', '2'] }`  |
 * | `?ids[]=1&…`    | `{ 'ids[]': '2' }`  | 422, no `ids` at all   |
 *
 * So the `ids[]=` convention is not merely stringly-typed here, it fails validation
 * — and reading an array back needs the route to declare one:
 * `.validate({ query: t.Object({ ids: t.Array(t.String()) }) })`.
 */
export type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue | QueryValue[]>

export type CallOptions = {
  method?: string

  /**
   * The body. An object is sent as JSON; `FormData` is sent as it is.
   *
   * The distinction is not cosmetic. `FormData` carries a boundary the runtime
   * decides once it has the form, so this must not set `content-type` — a
   * hand-written `multipart/form-data` header survives and the far end then cannot
   * parse the body, with nothing failing on this side.
   */
  body?: unknown

  query?: Query

  /** Overrides the token from the document — for a shell, which carries none. */
  token?: string

  /**
   * What goes in front of `path`. `/api` unless you say otherwise.
   *
   * Where a client's reads live, by convention, and where a miss stays a JSON 404
   * rather than becoming a document — which would reach a `fetch` as a parse error
   * three layers from the mistake. Addresses a browser also navigates to are not
   * under it, so a form posting to one clears this.
   */
  prefix?: string

  /**
   * Cancels the request — `new AbortController().signal`.
   *
   * A screen that navigates away while a read is in flight has nothing useful to
   * do with the answer, and a search box that fires per keystroke has several
   * answers it does not want. Without this the only way to ignore one is to check
   * a flag after it lands, which still pays for the transfer.
   */
  signal?: AbortSignal

  /** Extra headers. These win, so a caller can override any default below. */
  headers?: Record<string, string>
}

/** The whole answer, for a caller that needs more than the body. */
export type Answer<T> = {
  data: T
  status: number
  headers: Headers
}

/** `?a=1&b=2`, with the empty values left out. */
function queryString(query: Query): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one === null || one === undefined) continue

      search.append(key, String(one))
    }
  }

  return search.toString()
}

/** Does this body travel as it is, with the runtime deciding its content type? */
function passesThrough(body: unknown): boolean {
  return (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    typeof body === 'string'
  )
}

/**
 * One request, with the four things every request needs already decided, and the
 * whole answer handed back.
 *
 * `call` is this without the envelope, and is what most code wants. Reach for this
 * one when the status or a header is the answer — a `201` to tell apart from a
 * `200`, a `Location` to follow.
 *
 * ```ts
 * const { status, headers } = await send('/invoices', { method: 'POST', body })
 * ```
 */
export async function send<T>(path: string, options: CallOptions = {}): Promise<Answer<T>> {
  const query = queryString(options.query ?? {})
  const method = options.method ?? 'GET'
  /**
   * Read now, not at import.
   *
   * `page` is captured when the module evaluates, and a module can be imported
   * before the document it belongs to exists — in a test, and in anything
   * server-side. One small query per write costs nothing next to the request.
   */
  const token = options.token ?? embedded().csrf

  const prefix = options.prefix ?? '/api'
  const raw = passesThrough(options.body)

  const response = await fetch(`${prefix}${path}${query === '' ? '' : `?${query}`}`, {
    method,
    signal: options.signal,
    /**
     * No `Authorization` header anywhere in this file, and that is the point.
     *
     * The session is an `HttpOnly` cookie the browser attaches itself. A token
     * this code could read is a token an injected script could read, and one XSS
     * would then be a stolen session rather than a bad afternoon. `same-origin` is
     * already the default and is stated because it is load-bearing: the document
     * and the API are one origin, which is what lets a cookie work at all.
     */
    credentials: 'same-origin',
    headers: {
      /**
       * `accept`, and it is not decoration.
       *
       * The `auth` middleware answers a guest the way Laravel's does: 401 to a
       * client that asked for JSON, a redirect to a page for anything else.
       * Without this header an expired session sent `fetch` following a 302 to a
       * document, and `JSON.parse` then failed on HTML — a parse error standing in
       * for "you are signed out".
       */
      accept: 'application/json',
      // Never for a form or a blob: the runtime writes the boundary, and only it
      // knows what that boundary is.
      ...(options.body === undefined || raw ? {} : { 'content-type': 'application/json' }),
      /**
       * The token, on anything that changes state.
       *
       * A cookie is attached to requests other sites can make; this token is not.
       * Sending it on reads would be harmless and pointless — the server only
       * checks writes.
       */
      ...(method === 'GET' || token === undefined ? {} : { 'x-csrf-token': token }),
      ...options.headers
    },
    body:
      options.body === undefined
        ? undefined
        : raw
          ? (options.body as BodyInit)
          : JSON.stringify(options.body)
  })

  if (response.status === 401) throw new Unauthenticated()
  if (response.status === 423) throw new NeedsPasswordConfirmation()

  // 204 has no body, and `JSON.parse('')` throws.
  const text = await response.text()
  const payload = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)

  if (response.status === 422) {
    throw new Invalid(
      (payload.message as string) ?? 'That did not validate.',
      (payload.errors as Record<string, string[]>) ?? {}
    )
  }

  if (!response.ok) {
    throw new Error((payload.message as string) ?? `Request failed (${response.status})`)
  }

  return { data: payload as T, status: response.status, headers: response.headers }
}

/**
 * One request, answering with the body.
 *
 * ```ts
 * const invoices = await call<Page<Invoice>>('/invoices', { query: { status } })
 * ```
 */
export async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  return (await send<T>(path, options)).data
}

type VerbOptions = Omit<CallOptions, 'method'>

/**
 * The verbs, so a call names what it does rather than passing it in options.
 *
 * ```ts
 * const invoices = await http.get<Page<Invoice>>('/invoices', { query: { status } })
 *
 * await http.post('/avatar', { body: form })      // FormData, sent as it is
 * await http.patch(`/invoices/${id}`, { body: { paid: true } })
 * await http.delete(`/invoices/${id}`)
 * ```
 *
 * Nothing here is new behaviour — each is `call` with `method` filled in, and every
 * default above still applies.
 */
export const http = {
  get: <T>(path: string, options: VerbOptions = {}) => call<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, options: VerbOptions = {}) =>
    call<T>(path, { ...options, method: 'POST' }),
  put: <T>(path: string, options: VerbOptions = {}) => call<T>(path, { ...options, method: 'PUT' }),
  patch: <T>(path: string, options: VerbOptions = {}) =>
    call<T>(path, { ...options, method: 'PATCH' }),
  delete: <T>(path: string, options: VerbOptions = {}) =>
    call<T>(path, { ...options, method: 'DELETE' })
}
