import { TestResponse } from './response.ts'

/** What a test needs from the application: a way to press a route. */
export type Pressable = {
  handle(request: Request): Promise<Response>
  bound?(key: string): boolean
  make?(key: string): unknown
}

/** The slice of `AuthManager` `actingAs` uses, kept structural so this package
 * does not depend on `@elvel/auth` — the same way the notification manager
 * reaches the translator. */
type Impersonator = {
  impersonate(session: { user: unknown; session?: unknown } | null): void
  stopImpersonating(): void
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'

/**
 * A request being built — Laravel's `MakesHttpRequests`.
 *
 * Every builder method returns a new instance rather than mutating, so a
 * configured base can be shared:
 *
 * ```ts
 * const api = test(app).withToken(jwt).acceptJson()
 * await api.getJson('/posts')      // the base is untouched
 * await api.postJson('/posts', {}) // and reusable
 * ```
 *
 * Requests go through `app.handle()`, not a socket. That is Elysia's own entry
 * point, so routing, hooks, validation and the error handler all run — the only
 * thing skipped is the network, which is the thing a test does not want to pay
 * for.
 */
export class TestRequest {
  constructor(
    private readonly app: Pressable,
    private readonly headers: Record<string, string> = {},
    private readonly cookies: Record<string, string> = {},
    private readonly origin = 'http://localhost',
    private readonly redirects = 0
  ) {}

  private derive(changes: {
    headers?: Record<string, string>
    cookies?: Record<string, string>
    redirects?: number
  }): TestRequest {
    return new TestRequest(
      this.app,
      changes.headers ?? this.headers,
      changes.cookies ?? this.cookies,
      this.origin,
      changes.redirects ?? this.redirects
    )
  }

  withHeaders(headers: Record<string, string>): TestRequest {
    return this.derive({ headers: { ...this.headers, ...headers } })
  }

  withHeader(name: string, value: string): TestRequest {
    return this.withHeaders({ [name]: value })
  }

  withoutHeader(name: string): TestRequest {
    const headers = { ...this.headers }
    delete headers[name]

    return this.derive({ headers })
  }

  withToken(token: string, type = 'Bearer'): TestRequest {
    return this.withHeader('authorization', `${type} ${token}`)
  }

  withBasicAuth(username: string, password: string): TestRequest {
    return this.withHeader('authorization', `Basic ${btoa(`${username}:${password}`)}`)
  }

  /** Ask for JSON, which is what makes a form request return 422 over 302. */
  acceptJson(): TestRequest {
    return this.withHeader('accept', 'application/json')
  }

  withCookies(cookies: Record<string, string>): TestRequest {
    return this.derive({ cookies: { ...this.cookies, ...cookies } })
  }

  withCookie(name: string, value: string): TestRequest {
    return this.withCookies({ [name]: value })
  }

  /** Carry this response's cookies into the next request. */
  withCookiesFrom(response: TestResponse): TestRequest {
    return this.withCookies(
      Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]))
    )
  }

  /** The `referer`, which is what `redirect().back()` reads. */
  from(url: string): TestRequest {
    return this.withHeader('referer', this.url(url))
  }

  /**
   * Follow redirects, up to `max`.
   *
   * Off by default, and that is the useful default: most tests of a redirect
   * want to assert *where* it went, and following it throws that away.
   */
  followingRedirects(max = 10): TestRequest {
    return this.derive({ redirects: max })
  }

  /**
   * Run everything below as this user.
   *
   * Restored afterwards, including when an assertion throws, so one test cannot
   * leave another authenticated.
   */
  async actingAs<T>(user: unknown, callback: (request: TestRequest) => Promise<T>): Promise<T> {
    const auth = this.impersonator()
    if (!auth) {
      throw new Error('actingAs() needs the auth package. Register AuthServiceProvider.')
    }

    auth.impersonate({ user, session: { userId: (user as { id?: unknown })?.id } })

    try {
      return await callback(this)
    } finally {
      auth.stopImpersonating()
    }
  }

  private impersonator(): Impersonator | undefined {
    if (!this.app.bound?.('auth') || !this.app.make) return undefined

    return this.app.make('auth') as Impersonator
  }

  // ----------------------------------------------------------------- verbs

  get(url: string): Promise<TestResponse> {
    return this.call('GET', url)
  }
  head(url: string): Promise<TestResponse> {
    return this.call('HEAD', url)
  }
  options(url: string): Promise<TestResponse> {
    return this.call('OPTIONS', url)
  }
  post(url: string, body?: BodyInit | Record<string, unknown>): Promise<TestResponse> {
    return this.call('POST', url, body)
  }
  put(url: string, body?: BodyInit | Record<string, unknown>): Promise<TestResponse> {
    return this.call('PUT', url, body)
  }
  patch(url: string, body?: BodyInit | Record<string, unknown>): Promise<TestResponse> {
    return this.call('PATCH', url, body)
  }
  delete(url: string, body?: BodyInit | Record<string, unknown>): Promise<TestResponse> {
    return this.call('DELETE', url, body)
  }

  getJson(url: string): Promise<TestResponse> {
    return this.acceptJson().call('GET', url)
  }
  postJson(url: string, body?: unknown): Promise<TestResponse> {
    return this.json('POST', url, body)
  }
  putJson(url: string, body?: unknown): Promise<TestResponse> {
    return this.json('PUT', url, body)
  }
  patchJson(url: string, body?: unknown): Promise<TestResponse> {
    return this.json('PATCH', url, body)
  }
  deleteJson(url: string, body?: unknown): Promise<TestResponse> {
    return this.json('DELETE', url, body)
  }

  /** A JSON request: encoded body, and an `accept` that asks for JSON back. */
  json(method: Method, url: string, body?: unknown): Promise<TestResponse> {
    return this.acceptJson()
      .withHeader('content-type', 'application/json')
      .call(method, url, body === undefined ? undefined : JSON.stringify(body))
  }

  /** A form post, which is what a `<form>` sends and a form request expects. */
  form(method: Method, url: string, fields: Record<string, string>): Promise<TestResponse> {
    return this.withHeader('content-type', 'application/x-www-form-urlencoded').call(
      method,
      url,
      new URLSearchParams(fields).toString()
    )
  }

  async call(
    method: Method,
    url: string,
    body?: BodyInit | Record<string, unknown>
  ): Promise<TestResponse> {
    const headers = new Headers(this.headers)

    const entries = Object.entries(this.cookies)
    if (entries.length > 0) {
      headers.set(
        'cookie',
        entries.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
      )
    }

    let payload: BodyInit | undefined
    if (body !== undefined && body !== null) {
      const encodable =
        typeof body === 'object' &&
        !(body instanceof FormData) &&
        !(body instanceof URLSearchParams) &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer)

      if (encodable) {
        payload = JSON.stringify(body)
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      } else {
        payload = body as BodyInit
      }
    }

    let response = await this.app.handle(
      new Request(this.url(url), { method, headers, body: payload })
    )

    // Followed here rather than by the runtime: `app.handle()` has no network
    // behind it, so nothing else would.
    let hops = this.redirects
    while (hops > 0 && response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) break

      response = await this.app.handle(new Request(this.url(location), { method: 'GET', headers }))
      hops -= 1
    }

    return TestResponse.of(response)
  }

  private url(path: string): string {
    return /^https?:\/\//.test(path) ? path : new URL(path, this.origin).toString()
  }
}

/** Entry point: `test(app).getJson('/posts')`. */
export function test(app: Pressable): TestRequest {
  return new TestRequest(app)
}
