import { ConnectionError, HttpResponse, RequestError } from './response.ts'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** Decides whether a failed attempt is worth repeating. */
export type RetryWhen = (
  error: unknown,
  response: HttpResponse | undefined,
  attempt: number
) => boolean

export type RetryOptions = {
  times: number
  /** Milliseconds between attempts, or a function of the attempt number. */
  delay: number | ((attempt: number) => number)
  when?: RetryWhen
  /** Throw the last failure when the attempts run out. Laravel's default. */
  throw: boolean
}

/**
 * The options Bun's `fetch` adds beyond the standard.
 *
 * Forwarded rather than reimplemented — these reach into the runtime's own
 * networking and nothing at this layer could provide them.
 */
export type BunOptions = {
  /** `http://user:pass@proxy:3128`, for a client behind one. */
  proxy?: string
  /** A socket file instead of a host and port. */
  unix?: string
  /** Client certificates, or `rejectUnauthorized` for a private CA. */
  tls?: Record<string, unknown>
}

export type RequestOptions = BunOptions & {
  baseUrl?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: BodyInit
  timeout?: number
  retry?: RetryOptions
  redirect?: RequestRedirect
  throwOnFailure?: boolean

  /** Parts added by `attach()`, assembled into a `FormData` at send time. */
  attachments?: Array<{ name: string; contents: BodyInit; filename?: string }>

  /** `sink()` — where to write the body instead of holding it in memory. */
  sink?: string

  /** `maxRedirects()` — how many hops to follow, following them ourselves. */
  maxRedirects?: number

  /** Hooks, in the order they were added. */
  beforeSending?: Array<(attempt: Attempt) => void>
  afterResponse?: Array<(response: HttpResponse) => void>
}

/** What a fake answers with, and what the recorder keeps. */
export type Attempt = { method: Method; url: string; headers: Headers; body?: BodyInit }
export type Responder = (attempt: Attempt) => HttpResponse | Promise<HttpResponse>

/**
 * A request being configured — Laravel's `PendingRequest`.
 *
 * Immutable, like `PendingProcess` and `TestRequest` in this framework: every
 * option returns a new instance, so a configured base can be shared without one
 * call bleeding into the next.
 *
 * ```ts
 * const api = http().baseUrl('https://api.example.com').withToken(key).timeout(5_000)
 *
 * const user = await api.get('/users/7')
 * await api.retry(3, 200).post('/events', { kind: 'signup' })
 * ```
 */
export class PendingRequest {
  constructor(
    private readonly config: RequestOptions = {},
    private readonly responder?: Responder,
    private readonly recorder?: (attempt: Attempt, response: HttpResponse) => void,
    private readonly onStray?: (attempt: Attempt) => void
  ) {}

  private derive(changes: Partial<RequestOptions>): PendingRequest {
    return new PendingRequest(
      { ...this.config, ...changes },
      this.responder,
      this.recorder,
      this.onStray
    )
  }

  /** Prefixed onto every relative path. */
  baseUrl(url: string): PendingRequest {
    return this.derive({ baseUrl: url.replace(/\/$/, '') })
  }

  withHeaders(headers: Record<string, string>): PendingRequest {
    return this.derive({ headers: { ...this.config.headers, ...headers } })
  }

  withHeader(name: string, value: string): PendingRequest {
    return this.withHeaders({ [name]: value })
  }

  withToken(token: string, type = 'Bearer'): PendingRequest {
    return this.withHeader('authorization', `${type} ${token}`)
  }

  withBasicAuth(username: string, password: string): PendingRequest {
    return this.withHeader('authorization', `Basic ${btoa(`${username}:${password}`)}`)
  }

  withUserAgent(agent: string): PendingRequest {
    return this.withHeader('user-agent', agent)
  }

  acceptJson(): PendingRequest {
    return this.withHeader('accept', 'application/json')
  }

  /** Query parameters merged onto whatever the path already carries. */
  withQuery(query: Record<string, string>): PendingRequest {
    return this.derive({ query: { ...this.config.query, ...query } })
  }

  /** Milliseconds before the attempt is abandoned. */
  timeout(ms: number): PendingRequest {
    return this.derive({ timeout: ms })
  }

  /**
   * Try again, up to `times` attempts in total.
   *
   * `when` decides what is worth repeating, and the default is deliberately
   * narrow: a connection failure, a 429, and 5xx. Retrying a 400 or a 422 repeats
   * a request the server has already told you it will never accept, and retrying
   * a 401 can lock an account.
   *
   * `throw: false` hands back the last response instead of throwing when the
   * attempts run out, for a caller that wants to inspect the failure.
   */
  retry(
    times: number,
    delay: number | ((attempt: number) => number) = 0,
    when?: RetryWhen,
    shouldThrow = true
  ): PendingRequest {
    return this.derive({ retry: { times, delay, when, throw: shouldThrow } })
  }

  /**
   * Bun's own networking options, passed straight through.
   *
   * `proxy` for a client behind one, `unix` for a socket file, `tls` for a
   * private CA or a client certificate. Not reimplemented here and not
   * reinventable: they are the runtime's, and a client that swallowed them would
   * be unusable inside a corporate network.
   */
  /**
   * `attach('avatar', file, 'me.png')` — a multipart part, fluently.
   *
   * `asMultipart(path, form)` already sends a `FormData` somebody built; this is
   * the form Laravel uses, and it composes: several `attach` calls and the other
   * fields go together without the caller assembling anything.
   *
   * The parts are kept and turned into a `FormData` at send time rather than now,
   * because `PendingRequest` is immutable — building the form eagerly would mean
   * copying a `FormData` on every subsequent call.
   */
  attach(name: string, contents: BodyInit, filename?: string): PendingRequest {
    return this.derive({
      attachments: [...(this.config.attachments ?? []), { name, contents, filename }]
    })
  }

  /**
   * `sink('/tmp/report.pdf')` — write the body to a file as it arrives.
   *
   * For a download that should not be held in memory first. The response still
   * answers its status and headers; what it does not have is a body to read
   * twice, because the bytes went to the file.
   */
  sink(path: string): PendingRequest {
    return this.derive({ sink: path })
  }

  /**
   * Accept a certificate this machine does not trust — `withoutVerifying`.
   *
   * For a development server or a private CA, and named rather than left to
   * `withBunOptions({ tls: … })` so it is greppable: this is the switch somebody
   * turns on to get past an error and then forgets in production.
   *
   * Measured before it was added: Bun's `fetch` refuses a self-signed certificate
   * with "self signed certificate" and accepts it with this option, so the switch
   * does what it says.
   */
  withoutVerifying(): PendingRequest {
    return this.derive({ tls: { ...this.config.tls, rejectUnauthorized: false } })
  }

  /** `withCookies({ session: '…' })` — a `Cookie` header, spelt as cookies. */
  withCookies(cookies: Record<string, string>): PendingRequest {
    const pairs = Object.entries(cookies).map(([name, value]) => `${name}=${value}`)
    const existing = this.config.headers?.cookie

    return this.withHeader('cookie', [existing, ...pairs].filter(Boolean).join('; '))
  }

  /**
   * `maxRedirects(3)` — follow, but not forever.
   *
   * Followed here rather than by the runtime, because `fetch` offers only "follow
   * all" or "follow none": there is no count to pass it. So this asks for
   * `manual` and walks the chain, which is also what makes the limit observable —
   * the response you get back is the last hop, not an error about too many.
   *
   * A 303 becomes a GET and drops the body, as every client does: the whole point
   * of that status is "your write is done, now go and read this instead".
   */
  maxRedirects(hops: number): PendingRequest {
    return this.derive({ maxRedirects: hops, redirect: 'manual' })
  }

  /** Run before each attempt — Laravel's `beforeSending`. */
  beforeSending(hook: (attempt: Attempt) => void): PendingRequest {
    return this.derive({ beforeSending: [...(this.config.beforeSending ?? []), hook] })
  }

  /** Run on each response, whatever its status — Laravel's `afterResponse`. */
  afterResponse(hook: (response: HttpResponse) => void): PendingRequest {
    return this.derive({ afterResponse: [...(this.config.afterResponse ?? []), hook] })
  }

  /** `contentType('application/xml')`, which is a header with a name worth having. */
  contentType(type: string): PendingRequest {
    return this.withHeader('content-type', type)
  }

  /** Replace the headers rather than adding to them — Laravel's `replaceHeaders`. */
  replaceHeaders(headers: Record<string, string>): PendingRequest {
    return this.derive({ headers })
  }

  /** `asJson()` — say so explicitly, where a body would otherwise decide. */
  asJson(): PendingRequest {
    return this.withHeader('content-type', 'application/json').acceptJson()
  }

  /** Laravel's name for `withQuery`, kept so an example copies across. */
  withQueryParameters(query: Record<string, string>): PendingRequest {
    return this.withQuery(query)
  }

  /** Laravel's name for `withBunOptions`. */
  withOptions(options: BunOptions): PendingRequest {
    return this.withBunOptions(options)
  }

  withBunOptions(options: BunOptions): PendingRequest {
    return this.derive(options)
  }

  proxy(url: string): PendingRequest {
    return this.derive({ proxy: url })
  }

  /** Follow redirects, or do not — `withoutRedirecting()`. */
  withoutRedirecting(): PendingRequest {
    return this.derive({ redirect: 'manual' })
  }

  /** Throw on any 4xx or 5xx without calling `.throw()` at each call site. */
  throwOnFailure(shouldThrow = true): PendingRequest {
    return this.derive({ throwOnFailure: shouldThrow })
  }

  // ----------------------------------------------------------------- verbs

  get(path: string, query?: Record<string, string>): Promise<HttpResponse> {
    return (query ? this.withQuery(query) : this).send('GET', path)
  }

  head(path: string): Promise<HttpResponse> {
    return this.send('HEAD', path)
  }

  options(path: string): Promise<HttpResponse> {
    return this.send('OPTIONS', path)
  }

  post(path: string, body?: unknown): Promise<HttpResponse> {
    return this.withJson(body).send('POST', path)
  }

  put(path: string, body?: unknown): Promise<HttpResponse> {
    return this.withJson(body).send('PUT', path)
  }

  patch(path: string, body?: unknown): Promise<HttpResponse> {
    return this.withJson(body).send('PATCH', path)
  }

  delete(path: string, body?: unknown): Promise<HttpResponse> {
    return this.withJson(body).send('DELETE', path)
  }

  /** A form post, which is what a `<form>` sends. */
  asForm(
    path: string,
    fields: Record<string, string>,
    method: Method = 'POST'
  ): Promise<HttpResponse> {
    return this.withHeader('content-type', 'application/x-www-form-urlencoded')
      .derive({ body: new URLSearchParams(fields).toString() })
      .send(method, path)
  }

  /** A multipart post, for a file. */
  asMultipart(path: string, form: FormData, method: Method = 'POST'): Promise<HttpResponse> {
    // No `content-type` set on purpose: fetch writes it with the boundary, and a
    // hand-written one without the boundary makes the body unparseable.
    return this.derive({ body: form }).send(method, path)
  }

  private withJson(body: unknown): PendingRequest {
    if (body === undefined) return this

    const encodable =
      typeof body === 'object' &&
      body !== null &&
      !(body instanceof FormData) &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof Blob) &&
      !(body instanceof ArrayBuffer)

    if (!encodable) return this.derive({ body: body as BodyInit })

    return this.withHeader('content-type', 'application/json').derive({
      body: JSON.stringify(body)
    })
  }

  // ------------------------------------------------------------------ send

  async send(method: Method, path: string): Promise<HttpResponse> {
    const url = this.url(path)
    const headers = new Headers(this.config.headers)

    /**
     * The parts, assembled now rather than when `attach` was called.
     *
     * And the `content-type` header is *removed*: a multipart body needs a
     * boundary, which only the runtime knows once it has the form. Leaving a
     * hand-set `multipart/form-data` there produces a body the far end cannot
     * parse, with no error on this side.
     */
    let body = this.config.body

    if (this.config.attachments && this.config.attachments.length > 0) {
      const form = body instanceof FormData ? body : new FormData()

      for (const part of this.config.attachments) {
        if (part.filename !== undefined && typeof part.contents !== 'string') {
          form.append(part.name, part.contents as Blob, part.filename)
        } else {
          form.append(part.name, part.contents as string | Blob)
        }
      }

      headers.delete('content-type')
      body = form
    }

    const attempt: Attempt = { method, url, headers, body }

    const retry = this.config.retry ?? { times: 1, delay: 0, throw: true }
    let lastError: unknown
    let lastResponse: HttpResponse | undefined

    for (let round = 1; round <= Math.max(1, retry.times); round += 1) {
      try {
        const response = await this.attempt(attempt)
        this.recorder?.(attempt, response)

        if (!response.failed()) return response

        lastResponse = response
        lastError = undefined
      } catch (error) {
        lastError = error
        lastResponse = undefined
      }

      const worthRepeating = (retry.when ?? defaultRetryWhen)(lastError, lastResponse, round)
      if (round >= retry.times || !worthRepeating) break

      const wait = typeof retry.delay === 'function' ? retry.delay(round) : retry.delay
      if (wait > 0) await Bun.sleep(wait)
    }

    if (lastError !== undefined) throw lastError

    const response = lastResponse as HttpResponse

    // `retry(..., throw: false)` hands the failure back rather than throwing;
    // `throwOnFailure()` throws even without a retry policy.
    if ((this.config.retry && retry.throw) || this.config.throwOnFailure) {
      throw new RequestError(response)
    }

    return response
  }

  /**
   * Walk a redirect chain by hand, up to `maxRedirects`.
   *
   * `fetch` takes "follow all" or "follow none" and no count, so a limit has to be
   * enforced here. What comes back when the limit is reached is the last 3xx
   * itself rather than an error — a caller that set a limit is asking to see where
   * the chain went, and a thrown "too many redirects" hides it.
   *
   * A 303 becomes a GET and loses its body, which is what that status means.
   */
  private async follow(response: Response, attempt: Attempt): Promise<Response> {
    const limit = this.config.maxRedirects

    if (limit === undefined) return response

    let current = response
    let hops = 0

    while (hops < limit && current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location')

      if (location === null) return current

      const next = new URL(location, attempt.url).toString()
      const method = current.status === 303 ? 'GET' : attempt.method

      current = await fetch(next, {
        method,
        headers: attempt.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : attempt.body,
        redirect: 'manual',
        ...(this.config.tls === undefined ? {} : { tls: this.config.tls })
      })

      hops += 1
    }

    return current
  }

  private async attempt(attempt: Attempt): Promise<HttpResponse> {
    for (const hook of this.config.beforeSending ?? []) hook(attempt)

    if (this.responder) {
      const faked = await this.responder(attempt)

      for (const hook of this.config.afterResponse ?? []) hook(faked)

      return faked
    }

    this.onStray?.(attempt)

    try {
      const response = await fetch(attempt.url, {
        method: attempt.method,
        headers: attempt.headers,
        body: attempt.body,
        redirect: this.config.redirect ?? 'follow',
        // Bun's own, and only when asked: passing `undefined` for `unix` makes
        // Bun try to open a socket file called "undefined".
        ...(this.config.proxy === undefined ? {} : { proxy: this.config.proxy }),
        ...(this.config.unix === undefined ? {} : { unix: this.config.unix }),
        ...(this.config.tls === undefined ? {} : { tls: this.config.tls }),
        // `AbortSignal.timeout` aborts in the runtime rather than racing a
        // promise, so a slow response is actually cancelled and not merely
        // ignored while it keeps downloading.
        signal: this.config.timeout ? AbortSignal.timeout(this.config.timeout) : undefined
      })

      const followed = await this.follow(response, attempt)

      /**
       * The body goes to the file, and the response keeps everything else.
       *
       * Written from the stream and the `HttpResponse` then built with an empty
       * body, deliberately: `HttpResponse.of` reads the body into a string, and
       * doing both would hold in memory exactly what `sink` exists to avoid —
       * measured as a five-second timeout, because the second read waited on a
       * stream the first had already drained.
       *
       * So a sunk response answers its status and headers and has no body to
       * read. The bytes are in the file.
       */
      if (this.config.sink !== undefined) {
        await Bun.write(this.config.sink, followed)

        const sunk = new HttpResponse(followed, '', attempt.url)

        for (const hook of this.config.afterResponse ?? []) hook(sunk)

        return sunk
      }

      const answer = await HttpResponse.of(followed, attempt.url)

      for (const hook of this.config.afterResponse ?? []) hook(answer)

      return answer
    } catch (error) {
      throw new ConnectionError(attempt.url, error)
    }
  }

  private url(path: string): string {
    const base = /^https?:\/\//.test(path)
      ? path
      : `${this.config.baseUrl ?? ''}${path.startsWith('/') ? path : `/${path}`}`

    const query = this.config.query
    if (!query || Object.keys(query).length === 0) return base

    const url = new URL(base)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

    return url.toString()
  }
}

/**
 * What is worth trying again by default.
 *
 * A connection failure, a 429, and 5xx. Everything else is the server saying no
 * on purpose: repeating a 422 sends the same invalid body again, and repeating a
 * 401 is how an account gets locked.
 */
function defaultRetryWhen(error: unknown, response: HttpResponse | undefined): boolean {
  if (error instanceof ConnectionError) return true
  if (!response) return false

  return response.status === 429 || response.serverError()
}
