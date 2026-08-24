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

export type CallOptions = {
  method?: string
  body?: unknown
  query?: Record<string, string>

  /** Overrides the token from the document — for a shell, which carries none. */
  token?: string

  /**
   * What goes in front of `path`. `/api` unless you say otherwise.
   *
   * The default is the prefix `config/spa.ts` hands the exception handler, so a
   * 401 there arrives as JSON rather than as the document. Auth and settings do
   * **not** live under it — `/sign-in` and `/settings/profile` are the addresses a
   * browser navigates to as well — so a form posting to one passes `prefix: ''`.
   */
  prefix?: string
}

/**
 * One request, with the four things every request needs already decided.
 *
 * ```ts
 * const invoices = await call<Page<Invoice>>('/invoices', { query: { status } })
 * ```
 */
export async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const query = new URLSearchParams(options.query ?? {}).toString()
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

  const response = await fetch(`${prefix}${path}${query === '' ? '' : `?${query}`}`, {
    method,
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
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      /**
       * The token, on anything that changes state.
       *
       * A cookie is attached to requests other sites can make; this token is not.
       * Sending it on reads would be harmless and pointless — the server only
       * checks writes.
       */
      ...(method === 'GET' || token === undefined ? {} : { 'x-csrf-token': token })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
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

  return payload as T
}
