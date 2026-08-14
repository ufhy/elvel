import { type Attempt, type Method, PendingRequest, type Responder } from './pending.ts'
import { HttpResponse } from './response.ts'

/** What a fake answers with. */
export type FakeDefinition =
  | string
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | ((attempt: Attempt) => HttpResponse | Promise<HttpResponse>)

type Matcher = string | RegExp

/**
 * Does this URL match — exact, `*` wildcard, or a regular expression?
 *
 * `*` rather than a bare substring, for the same reason the process fake works
 * that way: a stub registered for `https://api.example.com/users` must not answer
 * `https://api.example.com/users/7/delete`, and a fake matching more than it
 * meant to is a test passing for the wrong reason.
 */
function matches(url: string, pattern: Matcher): boolean {
  if (pattern instanceof RegExp) return pattern.test(url)
  if (!pattern.includes('*')) return url === pattern

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')

  return new RegExp(`^${escaped}$`).test(url)
}

/** Build a response without a network — what a fake hands back. */
export function fakeResponse(
  definition: FakeDefinition,
  attempt: Attempt
): HttpResponse | Promise<HttpResponse> {
  if (typeof definition === 'function') return definition(attempt)

  const shape = typeof definition === 'string' ? { body: definition } : definition
  const body =
    typeof shape.body === 'string' || shape.body === undefined
      ? (shape.body ?? '')
      : JSON.stringify(shape.body)

  const headers = new Headers(shape.headers)
  if (typeof shape.body === 'object' && shape.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return new HttpResponse(
    new Response(body, { status: shape.status ?? 200, headers }),
    body,
    attempt.url
  )
}

/**
 * Makes requests — Laravel's `Http` facade.
 *
 * ```ts
 * const response = await http().withToken(key).get('https://api.example.com/users')
 * response.throw()
 * ```
 *
 * Under a fake nothing leaves the process and everything is recorded:
 *
 * ```ts
 * http().fake({ 'https://api.example.com/*': { body: { ok: true } } })
 * http().preventStrayRequests()
 * ```
 */
export class HttpClient {
  private fakes: Array<{ pattern: Matcher; answers: FakeDefinition[] }> = []
  private faking = false
  private recording = false
  private preventStray = false
  private readonly records: Array<{ attempt: Attempt; response: HttpResponse }> = []

  /** A configured starting point; every option returns a new one. */
  private base(): PendingRequest {
    return new PendingRequest(
      {},
      this.faking ? (attempt) => this.answer(attempt) : undefined,
      (attempt, response) => {
        /**
         * Only while recording, which `fake()` and `record()` turn on.
         *
         * Recording unconditionally looked harmless and is a slow leak: a server
         * that runs for a week keeps every outbound request and response it ever
         * made, and nothing ever reads them. Laravel guards the same array with
         * the same flag.
         */
        if (this.recording) this.records.push({ attempt, response })
      },
      (attempt) => this.guardStray(attempt)
    )
  }

  baseUrl(url: string): PendingRequest {
    return this.base().baseUrl(url)
  }
  withHeaders(headers: Record<string, string>): PendingRequest {
    return this.base().withHeaders(headers)
  }
  withHeader(name: string, value: string): PendingRequest {
    return this.base().withHeader(name, value)
  }
  withToken(token: string, type?: string): PendingRequest {
    return this.base().withToken(token, type)
  }
  withBasicAuth(username: string, password: string): PendingRequest {
    return this.base().withBasicAuth(username, password)
  }
  acceptJson(): PendingRequest {
    return this.base().acceptJson()
  }
  withQuery(query: Record<string, string>): PendingRequest {
    return this.base().withQuery(query)
  }
  timeout(ms: number): PendingRequest {
    return this.base().timeout(ms)
  }
  retry(...args: Parameters<PendingRequest['retry']>): PendingRequest {
    return this.base().retry(...args)
  }
  withoutRedirecting(): PendingRequest {
    return this.base().withoutRedirecting()
  }
  withBunOptions(options: Parameters<PendingRequest['withBunOptions']>[0]): PendingRequest {
    return this.base().withBunOptions(options)
  }
  proxy(url: string): PendingRequest {
    return this.base().proxy(url)
  }
  throwOnFailure(shouldThrow?: boolean): PendingRequest {
    return this.base().throwOnFailure(shouldThrow)
  }

  get(url: string, query?: Record<string, string>) {
    return this.base().get(url, query)
  }
  post(url: string, body?: unknown) {
    return this.base().post(url, body)
  }
  put(url: string, body?: unknown) {
    return this.base().put(url, body)
  }
  patch(url: string, body?: unknown) {
    return this.base().patch(url, body)
  }
  delete(url: string, body?: unknown) {
    return this.base().delete(url, body)
  }
  head(url: string) {
    return this.base().head(url)
  }
  asForm(
    url: string,
    fields: Record<string, string>,
    method?: Parameters<PendingRequest['asForm']>[2]
  ) {
    return this.base().asForm(url, fields, method)
  }
  asMultipart(url: string, form: FormData, method?: Parameters<PendingRequest['asMultipart']>[2]) {
    return this.base().asMultipart(url, form, method)
  }

  /**
   * Several at once — Laravel's `Http::pool`.
   *
   * Results come back keyed as they were declared, not as they finished, and a
   * failure is reported in place rather than rejecting the lot: the point of
   * asking for five things at once is usually to learn about all five.
   */
  async pool<T extends Record<string, (client: HttpClient) => Promise<HttpResponse>>>(
    requests: T
  ): Promise<Record<keyof T, HttpResponse | Error>> {
    const entries = Object.entries(requests)

    const settled = await Promise.all(
      entries.map(([, build]) =>
        build(this).catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error))
        )
      )
    )

    return Object.fromEntries(entries.map(([key], index) => [key, settled[index]])) as Record<
      keyof T,
      HttpResponse | Error
    >
  }

  // ------------------------------------------------------------------ fakes

  /**
   * Answer instead of calling out.
   *
   * A pattern may be given a list, consumed in order — for an endpoint expected
   * to be called more than once and answer differently, which is exactly what a
   * retry test needs. The last answer repeats once the list runs out rather than
   * falling through to a real request.
   */
  fake(definitions: Record<string, FakeDefinition | FakeDefinition[]> = {}): this {
    this.faking = true
    this.record()

    // Cleared, so assertions describe this test rather than everything the
    // process has done since it started. Laravel empties it here too.
    this.records.length = 0

    for (const [pattern, definition] of Object.entries(definitions)) {
      this.fakes.push({
        pattern,
        answers: Array.isArray(definition) ? definition : [definition]
      })
    }

    return this
  }

  /** Record without faking, for measuring what real code calls out to. */
  record(): this {
    this.recording = true

    return this
  }

  /** A sequence for one pattern: fails twice, then succeeds. */
  sequence(pattern: Matcher, answers: FakeDefinition[]): this {
    this.faking = true
    this.record()
    this.fakes.push({ pattern, answers: [...answers] })

    return this
  }

  /**
   * Refuse anything no fake matched.
   *
   * Without it an unmatched URL is called for real, which under a fake means a
   * test meant to be hermetic quietly reaches the network — slow, flaky, and
   * occasionally billed.
   */
  preventStrayRequests(prevent = true): this {
    this.preventStray = prevent

    return this
  }

  private guardStray(attempt: Attempt): void {
    if (!this.faking || !this.preventStray) return

    throw new Error(
      `A request to [${attempt.method} ${attempt.url}] was made while HTTP is faked, and no fake ` +
        `matched it. Add one with fake(), or allow it with preventStrayRequests(false).`
    )
  }

  private answer(attempt: Attempt): HttpResponse | Promise<HttpResponse> | never {
    const fake = this.fakes.find((one) => matches(attempt.url, one.pattern))

    if (!fake) {
      this.guardStray(attempt)

      // No stub and strays allowed: fall through to the network.
      return new PendingRequest().send(attempt.method as Method, attempt.url)
    }

    const definition =
      fake.answers.length > 1 ? (fake.answers.shift() as FakeDefinition) : fake.answers[0]

    return fakeResponse(definition as FakeDefinition, attempt)
  }

  stopFaking(): this {
    this.faking = false
    this.recording = false
    this.fakes = []
    this.records.length = 0

    return this
  }

  get isFaking(): boolean {
    return this.faking
  }

  /** Everything sent, faked or not. */
  recorded(): Array<{ attempt: Attempt; response: HttpResponse }> {
    return [...this.records]
  }

  // ------------------------------------------------------------- assertions

  assertSent(pattern: Matcher, method?: Method): this {
    const found = this.records.some(
      (one) => matches(one.attempt.url, pattern) && (!method || one.attempt.method === method)
    )

    if (!found) {
      throw new Error(
        `Expected a request matching ${String(pattern)}. Sent: ` +
          (this.records.length === 0
            ? '(nothing)'
            : this.records.map((one) => `[${one.attempt.method} ${one.attempt.url}]`).join(', '))
      )
    }

    return this
  }

  assertNotSent(pattern: Matcher): this {
    const found = this.records.find((one) => matches(one.attempt.url, pattern))

    if (found) {
      throw new Error(
        `Expected no request matching ${String(pattern)}, but [${found.attempt.url}] was sent.`
      )
    }

    return this
  }

  assertSentCount(count: number, pattern?: Matcher): this {
    const sent = pattern
      ? this.records.filter((one) => matches(one.attempt.url, pattern)).length
      : this.records.length

    if (sent !== count) {
      throw new Error(
        `Expected ${count} request(s)${pattern ? ` matching ${String(pattern)}` : ''}, saw ${sent}.`
      )
    }

    return this
  }

  assertNothingSent(): this {
    return this.assertSentCount(0)
  }

  /** In this order, though not necessarily next to each other. */
  assertSentInOrder(patterns: Matcher[]): this {
    let cursor = 0

    for (const pattern of patterns) {
      const at = this.records.findIndex(
        (one, index) => index >= cursor && matches(one.attempt.url, pattern)
      )

      if (at === -1) {
        throw new Error(
          `Expected ${String(pattern)} after the previous one. Sent: ` +
            this.records.map((one) => `[${one.attempt.url}]`).join(', ')
        )
      }

      cursor = at + 1
    }

    return this
  }
}
