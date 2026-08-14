/** A request that never got an answer — DNS, refused, reset, timed out. */
export class ConnectionError extends Error {
  constructor(
    readonly url: string,
    override readonly cause: unknown
  ) {
    super(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ConnectionError'
  }
}

/** A response that arrived and was a failure — Laravel's `RequestException`. */
export class RequestError extends Error {
  constructor(readonly response: HttpResponse) {
    /**
     * The body is in the message, truncated.
     *
     * A `RequestException` saying only "HTTP request returned status code 422"
     * sends you to a log to find out which field was wrong, and the answer was in
     * the body all along. Laravel truncates at 120 characters by default for the
     * same reason it includes it at all: enough to identify the failure, not
     * enough to fill a log with somebody's HTML error page.
     */
    const body = response.body.trim()
    const excerpt = body.length > 120 ? `${body.slice(0, 120)}…` : body

    super(`${response.status} from ${response.url}` + (excerpt === '' ? '' : `\n\n${excerpt}`))
    this.name = 'RequestError'
  }

  get status(): number {
    return this.response.status
  }
}

/**
 * A response, already read — Laravel's `Http\Client\Response`.
 *
 * The body is consumed once when the response is built, for the same reason
 * `TestResponse` does it: a `Response` body is a stream, and an assertion that
 * consumed it would poison every read after it.
 */
export class HttpResponse {
  private decoded: unknown
  private wasDecoded = false

  constructor(
    readonly response: Response,
    readonly body: string,
    /** The URL actually requested, which a redirect may have changed. */
    readonly url: string
  ) {}

  static async of(response: Response, url: string): Promise<HttpResponse> {
    return new HttpResponse(response, await response.text(), response.url || url)
  }

  get status(): number {
    return this.response.status
  }

  get headers(): Headers {
    return this.response.headers
  }

  header(name: string): string | null {
    return this.response.headers.get(name)
  }

  /** The decoded body, or `undefined` when it is not JSON. */
  json<T = unknown>(): T | undefined {
    if (!this.wasDecoded) {
      try {
        this.decoded = JSON.parse(this.body)
      } catch {
        this.decoded = undefined
      }
      this.wasDecoded = true
    }

    return this.decoded as T | undefined
  }

  successful(): boolean {
    return this.status >= 200 && this.status < 300
  }

  redirect(): boolean {
    return this.status >= 300 && this.status < 400
  }

  failed(): boolean {
    return this.clientError() || this.serverError()
  }

  clientError(): boolean {
    return this.status >= 400 && this.status < 500
  }

  serverError(): boolean {
    return this.status >= 500
  }

  ok(): boolean {
    return this.status === 200
  }
  unauthorized(): boolean {
    return this.status === 401
  }
  forbidden(): boolean {
    return this.status === 403
  }
  notFound(): boolean {
    return this.status === 404
  }
  unprocessable(): boolean {
    return this.status === 422
  }
  tooManyRequests(): boolean {
    return this.status === 429
  }

  /**
   * Throw if it failed, otherwise hand the response back so it chains.
   *
   * A failure is 4xx or 5xx and nothing else: a 3xx that was not followed is a
   * result, not an error, and treating it as one would break every caller using
   * `withoutRedirecting()` to read a `Location`.
   */
  throw(callback?: (response: HttpResponse, error: RequestError) => void): this {
    if (!this.failed()) return this

    const error = new RequestError(this)
    callback?.(this, error)

    throw error
  }

  throwIf(condition: boolean | ((response: HttpResponse) => boolean)): this {
    const decided = typeof condition === 'function' ? condition(this) : condition

    return decided ? this.throw() : this
  }

  throwUnless(condition: boolean | ((response: HttpResponse) => boolean)): this {
    const decided = typeof condition === 'function' ? condition(this) : condition

    return decided ? this : this.throw()
  }

  throwIfStatus(status: number): this {
    return this.status === status ? this.throw() : this
  }

  /** Every `set-cookie`, parsed into name and value. */
  cookies(): Record<string, string> {
    const out: Record<string, string> = {}

    for (const header of this.response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      const index = (pair ?? '').indexOf('=')
      if (index === -1) continue

      out[decodeURIComponent((pair as string).slice(0, index).trim())] = decodeURIComponent(
        (pair as string).slice(index + 1)
      )
    }

    return out
  }
}
