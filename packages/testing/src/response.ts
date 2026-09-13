import { assert, contains, dataGet, dataHas, equals, fail, show } from './assert.ts'
import { AssertableJson, matchesStructure } from './json.ts'

/** One parsed `set-cookie`, enough for the assertions that ask about them. */
export type ResponseCookie = {
  name: string
  value: string
  expires?: Date
  attributes: Record<string, string | true>
}

function parseCookie(header: string): ResponseCookie {
  const [pair, ...rest] = header.split(';')
  const index = (pair ?? '').indexOf('=')
  const name = index === -1 ? (pair ?? '') : (pair ?? '').slice(0, index)
  const value = index === -1 ? '' : (pair ?? '').slice(index + 1)

  const attributes: Record<string, string | true> = {}
  for (const part of rest) {
    const at = part.indexOf('=')
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase()
    if (key !== '') attributes[key] = at === -1 ? true : part.slice(at + 1).trim()
  }

  const expires = typeof attributes.expires === 'string' ? new Date(attributes.expires) : undefined

  return {
    name: decodeURIComponent(name.trim()),
    value: decodeURIComponent(value),
    expires,
    attributes
  }
}

/**
 * A response, already read, with assertions on it.
 *
 * The body is read once in `of()` and kept as text, because a `Response` body is
 * a stream that can only be consumed once and an assertion that consumed it
 * would poison every assertion after it. Everything here reads that text.
 */
export class TestResponse {
  private decoded: unknown
  private wasDecoded = false

  private constructor(
    readonly response: Response,
    readonly body: string,
    /**
     * The session as it was left, read back through the driver.
     *
     * Read after the response rather than during it: the request scope is gone
     * by the time an assertion runs, and the driver is where the data actually
     * ended up — which is also the half a test should be checking.
     */
    readonly session: Record<string, unknown> = {}
  ) {}

  static async of(
    response: Response,
    session: Record<string, unknown> = {}
  ): Promise<TestResponse> {
    return new TestResponse(response, await response.text(), session)
  }

  get status(): number {
    return this.response.status
  }

  get headers(): Headers {
    return this.response.headers
  }

  /** The decoded body, or a failure naming what could not be decoded. */
  json(path?: string): unknown {
    if (!this.wasDecoded) {
      try {
        this.decoded = JSON.parse(this.body)
      } catch {
        fail(`Expected a JSON body, but it could not be decoded. Saw: ${show(this.body)}`)
      }
      this.wasDecoded = true
    }

    return path === undefined ? this.decoded : dataGet(this.decoded, path)
  }

  get cookies(): ResponseCookie[] {
    return this.response.headers.getSetCookie().map(parseCookie)
  }

  cookie(name: string): ResponseCookie | undefined {
    return this.cookies.find((cookie) => cookie.name === name)
  }

  // ---------------------------------------------------------------- status

  /**
   * A failure here prints the body.
   *
   * A bare "expected 200, got 500" sends you to the server log to find out why,
   * and the reason is almost always already in the body — the exception handler
   * put it there. Printing it is the difference between one debugging step and
   * several.
   */
  assertStatus(expected: number): this {
    assert(
      this.status === expected,
      `Expected status ${expected}, saw ${this.status}. Body: ${show(this.body, 600)}`,
      expected,
      this.status
    )

    return this
  }

  assertSuccessful(): this {
    assert(
      this.status >= 200 && this.status < 300,
      `Expected a successful status, saw ${this.status}. Body: ${show(this.body, 600)}`
    )

    return this
  }

  assertClientError(): this {
    assert(this.status >= 400 && this.status < 500, `Expected a 4xx status, saw ${this.status}`)

    return this
  }

  assertServerError(): this {
    assert(this.status >= 500, `Expected a 5xx status, saw ${this.status}`)

    return this
  }

  assertOk(): this {
    return this.assertStatus(200)
  }
  assertCreated(): this {
    return this.assertStatus(201)
  }
  assertAccepted(): this {
    return this.assertStatus(202)
  }
  assertNoContent(status = 204): this {
    this.assertStatus(status)
    assert(this.body === '', `Expected an empty body, saw ${show(this.body)}`)

    return this
  }
  assertMovedPermanently(): this {
    return this.assertStatus(301)
  }
  assertFound(): this {
    return this.assertStatus(302)
  }
  assertNotModified(): this {
    return this.assertStatus(304)
  }
  assertTemporaryRedirect(): this {
    return this.assertStatus(307)
  }
  assertPermanentRedirect(): this {
    return this.assertStatus(308)
  }
  assertBadRequest(): this {
    return this.assertStatus(400)
  }
  assertUnauthorized(): this {
    return this.assertStatus(401)
  }
  assertPaymentRequired(): this {
    return this.assertStatus(402)
  }
  assertForbidden(): this {
    return this.assertStatus(403)
  }
  assertNotFound(): this {
    return this.assertStatus(404)
  }
  assertMethodNotAllowed(): this {
    return this.assertStatus(405)
  }
  assertNotAcceptable(): this {
    return this.assertStatus(406)
  }
  assertRequestTimeout(): this {
    return this.assertStatus(408)
  }
  assertConflict(): this {
    return this.assertStatus(409)
  }
  assertGone(): this {
    return this.assertStatus(410)
  }
  assertPayloadTooLarge(): this {
    return this.assertStatus(413)
  }
  assertUnsupportedMediaType(): this {
    return this.assertStatus(415)
  }
  assertUnprocessable(): this {
    return this.assertStatus(422)
  }
  assertTooManyRequests(): this {
    return this.assertStatus(429)
  }
  assertInternalServerError(): this {
    return this.assertStatus(500)
  }
  assertServiceUnavailable(): this {
    return this.assertStatus(503)
  }

  // --------------------------------------------------------------- content

  assertContent(expected: string): this {
    assert(
      this.body === expected,
      `Expected the body to be ${show(expected)}, saw ${show(this.body)}`
    )

    return this
  }

  assertSee(value: string | string[]): this {
    for (const needle of Array.isArray(value) ? value : [value]) {
      assert(
        this.body.includes(needle),
        `Expected the body to contain ${show(needle)}. Body: ${show(this.body, 600)}`
      )
    }

    return this
  }

  assertDontSee(value: string | string[]): this {
    for (const needle of Array.isArray(value) ? value : [value]) {
      assert(
        !this.body.includes(needle),
        `Expected the body not to contain ${show(needle)}, but it does`
      )
    }

    return this
  }

  /**
   * Seen in this order, without overlapping.
   *
   * Ordering is most of what a rendered list is: that the rows came back sorted
   * is not something `assertSee` can tell you.
   */
  assertSeeInOrder(values: string[]): this {
    let cursor = 0
    for (const needle of values) {
      const found = this.body.indexOf(needle, cursor)
      assert(
        found !== -1,
        `Expected to see ${show(needle)} after the previous value, but it does not appear there. ` +
          `Body: ${show(this.body, 600)}`
      )
      cursor = found + needle.length
    }

    return this
  }

  /** Tags stripped first, so copy is asserted without markup around it. */
  assertSeeText(value: string | string[]): this {
    const text = this.text()
    for (const needle of Array.isArray(value) ? value : [value]) {
      assert(
        text.includes(needle),
        `Expected the body's text to contain ${show(needle)}. Text: ${show(text, 600)}`
      )
    }

    return this
  }

  assertDontSeeText(value: string | string[]): this {
    const text = this.text()
    for (const needle of Array.isArray(value) ? value : [value]) {
      assert(
        !text.includes(needle),
        `Expected the body's text not to contain ${show(needle)}, but it does`
      )
    }

    return this
  }

  /** The body with tags removed and whitespace collapsed. */
  text(): string {
    return this.body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  // ------------------------------------------------------------------ json

  /** Contains this, ignoring anything not named. */
  assertJson(expected: unknown): this {
    const body = this.json()
    assert(
      contains(body, expected),
      `Expected the JSON body to contain ${show(expected)}, saw ${show(body, 600)}`,
      expected,
      body
    )

    return this
  }

  /** Exactly this, key order aside. */
  assertExactJson(expected: unknown): this {
    const body = this.json()
    assert(
      equals(body, expected),
      `Expected the JSON body to be exactly ${show(expected)}, saw ${show(body, 600)}`,
      expected,
      body
    )

    return this
  }

  /**
   * Overloaded rather than a union, because `unknown | Fn` collapses to
   * `unknown` — which silently strips the callback's parameter type and makes
   * every `assertJsonPath(path, (value) => …)` an implicit `any`.
   */
  assertJsonPath(path: string, check: (value: unknown) => boolean): this
  assertJsonPath(path: string, expected: unknown): this
  assertJsonPath(path: string, expected: unknown): this {
    const found = this.json(path)

    if (typeof expected === 'function') {
      assert(
        (expected as (value: unknown) => boolean)(found),
        `Expected [${path}] to satisfy the callback, saw ${show(found)}`
      )

      return this
    }

    assert(
      equals(found, expected),
      `Expected [${path}] to be ${show(expected)}, saw ${show(found)}`,
      expected,
      found
    )

    return this
  }

  assertJsonMissingPath(path: string): this {
    assert(
      !dataHas(this.json(), path),
      `Expected [${path}] to be absent, but it is ${show(this.json(path))}`
    )

    return this
  }

  /** Keys only, values ignored; `*` walks every element of an array. */
  assertJsonStructure(structure: unknown): this {
    const failure = matchesStructure(this.json(), structure)
    if (failure) fail(failure)

    return this
  }

  assertJsonCount(count: number, path?: string): this {
    const found = path === undefined ? this.json() : this.json(path)
    const where = path === undefined ? 'the JSON body' : `[${path}]`

    if (Array.isArray(found)) {
      assert(
        found.length === count,
        `Expected ${where} to have ${count} items, saw ${found.length}`,
        count,
        found.length
      )

      return this
    }

    assert(
      found !== null && typeof found === 'object',
      `Expected ${where} to be an array or object, saw ${show(found)}`
    )
    const size = Object.keys(found as Record<string, unknown>).length
    assert(size === count, `Expected ${where} to have ${count} keys, saw ${size}`, count, size)

    return this
  }

  /** Somewhere in the body, at any depth — for a row inside a list. */
  assertJsonFragment(fragment: Record<string, unknown>): this {
    assert(
      this.findFragment(this.json(), fragment),
      `Expected to find ${show(fragment)} somewhere in the JSON body, saw ${show(this.json(), 600)}`
    )

    return this
  }

  assertJsonMissingFragment(fragment: Record<string, unknown>): this {
    assert(
      !this.findFragment(this.json(), fragment),
      `Expected not to find ${show(fragment)} in the JSON body, but it is there`
    )

    return this
  }

  private findFragment(value: unknown, fragment: Record<string, unknown>): boolean {
    if (value === null || typeof value !== 'object') return false
    if (!Array.isArray(value) && contains(value, fragment)) return true

    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)

    return children.some((child) => this.findFragment(child, fragment))
  }

  assertJsonIsArray(): this {
    assert(
      Array.isArray(this.json()),
      `Expected the JSON body to be an array, saw ${show(this.json())}`
    )

    return this
  }

  assertJsonIsObject(): this {
    const body = this.json()
    assert(
      body !== null && typeof body === 'object' && !Array.isArray(body),
      `Expected the JSON body to be an object, saw ${show(body)}`
    )

    return this
  }

  /** The fluent walk, held to what it touched unless it calls `etc()`. */
  assertJsonFluent(callback: (json: AssertableJson) => void): this {
    new AssertableJson(this.json()).verify(callback)

    return this
  }

  // ------------------------------------------------------------ validation

  /**
   * The 422 named these fields.
   *
   * The framework's exception handler renders a `ValidationError` as
   * `{ message, errors: { field: [...] } }`, so
   * these read the `errors` bag rather than the whole body.
   */
  assertInvalid(fields: string | string[] | Record<string, string>): this {
    this.assertStatus(422)
    const bag = (this.json('errors') ?? {}) as Record<string, string[]>

    const expected =
      typeof fields === 'string'
        ? { [fields]: undefined }
        : Array.isArray(fields)
          ? Object.fromEntries(fields.map((field) => [field, undefined]))
          : fields

    for (const [field, message] of Object.entries(expected)) {
      assert(
        field in bag,
        `Expected a validation error for [${field}], saw errors for [${Object.keys(bag).join(', ')}]`
      )

      if (message === undefined) continue

      const messages = bag[field] ?? []
      assert(
        messages.some((line) => line.includes(message)),
        `Expected the error for [${field}] to contain ${show(message)}, saw ${show(messages)}`
      )
    }

    return this
  }

  assertValid(fields?: string | string[]): this {
    const bag = (this.status === 422 ? (this.json('errors') ?? {}) : {}) as Record<string, string[]>

    if (fields === undefined) {
      assert(
        Object.keys(bag).length === 0,
        `Expected no validation errors, saw ${show(Object.keys(bag))}`
      )

      return this
    }

    for (const field of Array.isArray(fields) ? fields : [fields]) {
      assert(
        !(field in bag),
        `Expected no validation error for [${field}], saw ${show(bag[field])}`
      )
    }

    return this
  }

  // --------------------------------------------------------------- headers

  assertHeader(name: string, expected?: string): this {
    const found = this.headers.get(name)
    assert(found !== null, `Expected a [${name}] header, saw none`)

    if (expected !== undefined) {
      assert(
        found === expected,
        `Expected [${name}] to be ${show(expected)}, saw ${show(found)}`,
        expected,
        found
      )
    }

    return this
  }

  assertHeaderContains(name: string, expected: string): this {
    const found = this.headers.get(name)
    assert(found !== null, `Expected a [${name}] header, saw none`)
    assert(
      (found as string).includes(expected),
      `Expected [${name}] to contain ${show(expected)}, saw ${show(found)}`
    )

    return this
  }

  assertHeaderMissing(name: string): this {
    assert(
      this.headers.get(name) === null,
      `Expected no [${name}] header, saw ${show(this.headers.get(name))}`
    )

    return this
  }

  // --------------------------------------------------------------- cookies

  assertCookie(name: string, expected?: string): this {
    const cookie = this.cookie(name)
    assert(
      cookie !== undefined,
      `Expected a [${name}] cookie, saw [${this.cookies.map((one) => one.name).join(', ')}]`
    )

    if (expected !== undefined) {
      assert(
        (cookie as ResponseCookie).value === expected,
        `Expected cookie [${name}] to be ${show(expected)}, saw ${show((cookie as ResponseCookie).value)}`
      )
    }

    return this
  }

  assertCookieMissing(name: string): this {
    assert(this.cookie(name) === undefined, `Expected no [${name}] cookie, but one was set`)

    return this
  }

  /**
   * The cookie was told to expire.
   *
   * A cleared cookie is a cookie sent with a past expiry, not an absent one —
   * the browser needs the instruction. Asserting absence would pass on a
   * response that never touched it.
   */
  assertCookieExpired(name: string): this {
    this.assertCookie(name)
    const cookie = this.cookie(name) as ResponseCookie
    const expires = cookie.expires

    assert(
      (expires !== undefined && expires.getTime() < Date.now()) ||
        cookie.attributes['max-age'] === '0',
      `Expected cookie [${name}] to be expired, saw ${show(cookie.attributes)}`
    )

    return this
  }

  // -------------------------------------------------------------- redirect

  assertRedirect(location?: string): this {
    assert(
      this.status >= 300 && this.status < 400,
      `Expected a redirect status, saw ${this.status}. Body: ${show(this.body, 300)}`
    )

    const found = this.headers.get('location')
    assert(found !== null, 'Expected a [location] header on the redirect, saw none')

    if (location !== undefined) {
      assert(
        found === location,
        `Expected a redirect to ${show(location)}, saw ${show(found)}`,
        location,
        found
      )
    }

    return this
  }

  assertRedirectContains(fragment: string): this {
    this.assertRedirect()
    const found = this.headers.get('location') as string
    assert(
      found.includes(fragment),
      `Expected the redirect to contain ${show(fragment)}, saw ${show(found)}`
    )

    return this
  }

  // --------------------------------------------------------------- session

  /**
   * The session, after the request.
   *
   * "Post an invalid form, get redirected back, with the errors and the old
   * input in the session" is the commonest flow in a server-rendered
   * application, and asserting it meant following the redirect and searching the
   * HTML for the message — which passes for the wrong reason as often as the
   * right one.
   */
  assertSessionHas(key: string, value?: unknown): this {
    const held = sessionValue(this.session, key)

    assert(
      held !== MISSING,
      `Expected the session to hold [${key}], saw ${show(Object.keys(this.session))}`
    )

    if (value !== undefined) {
      assert(
        equals(held, value),
        `Expected session [${key}] to be ${show(value)}, saw ${show(held)}`,
        value,
        held
      )
    }

    return this
  }

  assertSessionHasAll(values: Record<string, unknown> | string[]): this {
    const entries = Array.isArray(values)
      ? values.map((key) => [key, undefined] as const)
      : Object.entries(values)

    for (const [key, value] of entries) this.assertSessionHas(key, value)

    return this
  }

  assertSessionMissing(key: string): this {
    assert(
      sessionValue(this.session, key) === MISSING,
      `Expected the session not to hold [${key}], saw ${show(sessionValue(this.session, key))}`
    )

    return this
  }

  /** The errors flashed for a redirect back, in the default bag or a named one. */
  assertSessionHasErrors(keys?: string[] | Record<string, string>, bag = 'default'): this {
    const errors = errorsIn(this.session, bag)

    assert(
      Object.keys(errors).length > 0,
      `Expected the session to hold validation errors${bag === 'default' ? '' : ` in [${bag}]`}, saw none`
    )

    if (keys === undefined) return this

    const wanted = Array.isArray(keys)
      ? keys.map((key) => [key, undefined] as const)
      : Object.entries(keys)

    for (const [field, message] of wanted) {
      const messages = errors[field]

      assert(
        messages !== undefined,
        `Expected an error for [${field}], saw ${show(Object.keys(errors))}`
      )

      if (message !== undefined) {
        assert(
          (messages as string[]).includes(message),
          `Expected [${field}] to report ${show(message)}, saw ${show(messages)}`,
          message,
          messages
        )
      }
    }

    return this
  }

  assertSessionHasErrorsIn(bag: string, keys?: string[] | Record<string, string>): this {
    return this.assertSessionHasErrors(keys, bag)
  }

  assertSessionHasNoErrors(keys?: string[]): this {
    const errors = errorsIn(this.session, 'default')

    if (keys === undefined) {
      assert(
        Object.keys(errors).length === 0,
        `Expected no validation errors, saw ${show(Object.keys(errors))}`
      )

      return this
    }

    for (const key of keys) {
      assert(errors[key] === undefined, `Expected no error for [${key}], saw ${show(errors[key])}`)
    }

    return this
  }

  assertSessionDoesntHaveErrors(keys?: string[]): this {
    return this.assertSessionHasNoErrors(keys)
  }

  /** What the user typed, kept so the form can be redrawn with it. */
  assertSessionHasInput(key: string, value?: unknown): this {
    const old = (this.session._old_input ?? {}) as Record<string, unknown>

    assert(key in old, `Expected the old input to hold [${key}], saw ${show(Object.keys(old))}`)

    if (value !== undefined) {
      assert(
        equals(old[key], value),
        `Expected old input [${key}] to be ${show(value)}, saw ${show(old[key])}`,
        value,
        old[key]
      )
    }

    return this
  }

  assertSessionMissingInput(key: string): this {
    const old = (this.session._old_input ?? {}) as Record<string, unknown>

    assert(!(key in old), `Expected the old input not to hold [${key}], saw ${show(old[key])}`)

    return this
  }

  /** Sent back where it came from — what a failed form does. */
  assertRedirectBack(): this {
    this.assertRedirect()

    const previous = this.session['_previous.url']
    const found = this.headers.get('location')

    if (typeof previous === 'string') {
      assert(
        found === previous,
        `Expected a redirect back to ${show(previous)}, saw ${show(found)}`,
        previous,
        found
      )
    }

    return this
  }

  assertRedirectBackWithErrors(keys?: string[] | Record<string, string>): this {
    return this.assertRedirectBack().assertSessionHasErrors(keys)
  }

  /**
   * A redirect to a named route.
   *
   * The name is resolved through the registry, so a renamed route fails here
   * rather than in the browser — which is the whole reason route names exist.
   */
  assertRedirectToRoute(
    routes: { to(name: string, parameters?: Record<string, unknown>): string },
    name: string,
    parameters: Record<string, unknown> = {}
  ): this {
    return this.assertRedirect(routes.to(name, parameters))
  }

  // ----------------------------------------------------------------- bodies

  /** A download: the disposition says attachment, and it names a file. */
  assertDownload(filename?: string): this {
    const disposition = this.headers.get('content-disposition') ?? ''

    assert(
      disposition.toLowerCase().startsWith('attachment'),
      `Expected an attachment, saw ${show(disposition)}`
    )

    if (filename !== undefined) {
      assert(
        disposition.includes(`filename="${filename}"`) ||
          disposition.includes(`filename*=UTF-8''${encodeURIComponent(filename)}`),
        `Expected the download to be named ${show(filename)}, saw ${show(disposition)}`
      )
    }

    return this
  }

  /**
   * A streamed response.
   *
   * The body is already read by the time this runs, so what is asserted is that
   * it was *sent* as a stream — no `content-length`, which is what a chunked or
   * unbounded response looks like on the wire.
   */
  assertStreamed(): this {
    assert(
      this.headers.get('content-length') === null,
      `Expected a streamed response, saw a content-length of ${show(this.headers.get('content-length'))}`
    )

    return this
  }

  assertStreamedContent(expected: string): this {
    this.assertStreamed()

    assert(
      this.body === expected,
      `Expected the streamed body to be ${show(expected)}, saw ${show(this.body, 300)}`,
      expected,
      this.body
    )

    return this
  }

  /** Anything this class does not cover, without reaching past it. */
  tap(callback: (response: this) => void): this {
    callback(this)

    return this
  }
}

/** Nothing a session could legitimately hold, so "absent" is distinguishable. */
const MISSING = Symbol('missing')

/** Dot access, so a nested flash can be asserted the way it is read. */
function sessionValue(session: Record<string, unknown>, key: string): unknown {
  return dataHas(session, key) ? dataGet(session, key) : MISSING
}

/**
 * The errors for a bag.
 *
 * Named bags live under a sentinel key rather than beside the fields, because
 * two forms on one page each need their own — so reading the default bag means
 * checking whether the sentinel is there at all.
 */
function errorsIn(session: Record<string, unknown>, bag: string): Record<string, unknown> {
  const errors = (session.errors ?? {}) as Record<string, unknown>
  const bagged = errors[BAGGED] as Record<string, Record<string, unknown>> | undefined

  if (bagged !== undefined) return bagged[bag] ?? {}

  return bag === 'default' ? errors : {}
}

/** The same sentinel `@elvel/http` writes; a string here would collide with a field. */
const BAGGED = '__bags'
