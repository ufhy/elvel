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
    const attempt: Attempt = { method, url, headers, body: this.config.body }

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

  private async attempt(attempt: Attempt): Promise<HttpResponse> {
    if (this.responder) return this.responder(attempt)

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

      return HttpResponse.of(response, attempt.url)
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
