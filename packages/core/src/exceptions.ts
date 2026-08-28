import type { ApplicationContract, ExceptionHandlerContract } from '@elvel/contracts'

/**
 * Base class for exceptions that carry their own HTTP response, mirroring
 * Laravel's `HttpException` family.
 */
/**
 * Marks an exception that carries its own finished `Response`.
 *
 * A symbol, and `Symbol.for` so two copies of this package agree on it. Core
 * cannot import `@elvel/http`, and this is the whole contract between them.
 */
export const CARRIES_RESPONSE: unique symbol = Symbol.for(
  'elvel.carriesResponse'
) as typeof CARRIES_RESPONSE

export type CarriesResponse = { [CARRIES_RESPONSE](): Response }

export function carriesResponse(error: unknown): error is CarriesResponse {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as Record<PropertyKey, unknown>)[CARRIES_RESPONSE] === 'function'
  )
}

export class HttpException extends Error {
  constructor(
    readonly status: number,
    message?: string,
    /**
     * Headers the response must carry.
     *
     * Some statuses are not usable without them: a 429 without `Retry-After`
     * tells a client to back off but not for how long, so it guesses — and a
     * client guessing is what turns a rate limit into a retry storm.
     */
    readonly headers: Record<string, string> = {}
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = new.target.name
  }
}

export class NotFoundException extends HttpException {
  constructor(message = 'Not Found') {
    super(404, message)
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden') {
    super(403, message)
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = 'Unauthorized') {
    super(401, message)
  }
}

/**
 * ExceptionHandler — the `HandleExceptions` bootstrapper.
 *
 * Renders a JSON problem response. The HTML/redirect branch (Laravel's
 * `Whoops`-style debug page and the `back()->withErrors()` flow) belongs to
 * the http/session packages and lands with them, not here.
 */
export class ExceptionHandler implements ExceptionHandlerContract {
  constructor(protected readonly app: ApplicationContract) {}

  /**
   * Is this error worth a log line? Client mistakes are not.
   *
   * Everything used to be reported, so a browser asking for a `/favicon.ico` an
   * application does not have produced `ERROR [stack] NOT_FOUND` and a stack
   * trace through `@elysiajs/static` — an application error, in the log, for a
   * request that was answered correctly. Laravel has the same rule and the same
   * reason: `NotFoundHttpException`, `HttpException`, `ValidationException` and
   * friends are all in its `internalDontReport`.
   *
   * 4xx says the caller got it wrong and the answer already told them. 5xx says
   * this application got it wrong, and that is what a log is for. Override this
   * to report a status anyway — a 403 worth watching, say — or to silence one.
   *
   * Only 5xx, not "anything but 4xx". The earlier rule reported everything below
   * 400 as well, which sounds like nothing until an exception is used for control
   * flow: a redirect thrown by validation is a `302`, and every failed form
   * submission wrote `ERROR [stack] Redirecting to /subscribe` with a stack trace
   * through `failedValidation`. Nothing had gone wrong — the browser was on its
   * way back to the form it came from.
   *
   * The access log is the place to see 404s: `logging.requests.enabled`.
   */
  protected shouldReport(error: unknown): boolean {
    return this.statusFor(error) >= 500
  }

  report(error: unknown): void {
    if (this.app.environment() === 'testing') return
    if (!this.shouldReport(error)) return

    // Prefer the log manager when the log package is installed, so reports obey
    // the configured channels. Core cannot depend on it, hence the duck test.
    if (this.app.bound('log')) {
      const logger = this.app.make('log' as never) as {
        error(message: string, context?: Record<string, unknown>): void
      }

      logger.error(ExceptionHandler.messageOf(error), {
        exception: error instanceof Error ? error.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined
      })

      return
    }

    console.error(error)
  }

  /**
   * Typed as the contract types it, so an application can answer asynchronously.
   *
   * `ExceptionHandlerContract.render` has always allowed `Promise<Response>` and
   * this class narrowed it to `Response` — which made the override the contract
   * invites impossible: a handler that renders a document, and therefore reads
   * from a database, cannot be synchronous. Found by writing one; the runtime was
   * already fine because the hook awaits.
   */
  render(error: unknown, _context: { request: Request }): Response | Promise<Response> {
    /**
     * An exception may *be* the response — a redirect thrown from validation.
     *
     * Recognised by an explicit symbol, not by having a `toResponse` method.
     * Duck-typing that shape was the first attempt and it silently hijacked
     * Elysia's own error classes, which have one too: every framework error
     * started answering with Elysia's response instead of ours, and what surfaced
     * was an unrelated policy check failing to parse its body as JSON.
     */
    if (carriesResponse(error)) return error[CARRIES_RESPONSE]()

    /**
     * A browser that failed a route schema goes back to its form — Laravel's rule.
     *
     * `FormRequest` has answered this way since it existed: an API client gets the
     * 422 with the bag, a browser is sent back with the messages and what it typed.
     * `Route.validate({ body: t.Object(…) })` had neither half, because Elysia
     * refuses before any of that runs — measured, a blank sign-up form was answered
     * with a page of error markup and everything typed into it was gone.
     *
     * Asked of the container rather than built here: the redirect needs the session
     * and the negotiation rule, both of which live in `@elvel/http`, and core cannot
     * depend on it. An application without that package simply has no binding and
     * falls through to the 422 below.
     *
     * A route hook was the first attempt and never ran: this handler is wired into
     * Elysia's error pipeline before any provider registers, and the first to answer
     * wins.
     */
    const sentBack = this.sendBack(error, _context.request)

    if (sentBack !== undefined) return sentBack

    const status = this.statusFor(error)
    const debug = this.app.hasDebugModeEnabled()

    const payload: Record<string, unknown> = {
      message: this.messageFor(error, status, debug)
    }

    // An error may carry a field-keyed bag (validation). Rendering it here keeps
    // a single error renderer: a second onError would race this one, and Elysia
    // uses whichever handler answers first.
    const errors = ExceptionHandler.errorsOf(error)
    if (errors) payload.errors = errors

    if (debug && error instanceof Error) {
      payload.exception = error.name
      payload.stack = error.stack?.split('\n').map((line) => line.trim())
    }

    const headers = ExceptionHandler.headersOf(error)

    /**
     * A browser gets HTML; everything else gets JSON.
     *
     * Decided from `Accept`, and only when the client asked for HTML *before*
     * JSON — an API client sending a wildcard Accept still gets JSON, which is what makes
     * this safe to apply to every route rather than only to web ones. A 403 from
     * a policy rendered as `"message":"..."` in a browser window is the shape
     * that made this worth doing.
     */
    if (wantsHtml(_context.request)) {
      return new Response(this.renderHtml(status, payload, debug), {
        status,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' }
      })
    }

    return Response.json(payload, { status, headers })
  }

  /**
   * The HTML for an error page.
   *
   * Deliberately one self-contained document with no stylesheet link: an error
   * page that depends on an asset pipeline is an error page that renders as
   * unstyled text on the day the asset pipeline is what broke. Override this
   * method to render one of the application's own views instead.
   */
  protected renderHtml(status: number, payload: Record<string, unknown>, debug: boolean): string {
    const title = escapeHtml(String(payload.message ?? 'Something went wrong.'))
    /**
     * `${…}`, not `$…` — the interpolation was missing its braces.
     *
     * The debug error page printed the literal text
     * `$escapeHtml((payload.stack as string[]).join('\n'))` where the stack trace
     * belonged, so the one screen whose entire job is to say what went wrong said
     * nothing about it. Found by hitting a 404 in a browser, which is the only
     * place this branch is ever seen.
     */
    const stack =
      debug && Array.isArray(payload.stack)
        ? `<pre>${escapeHtml((payload.stack as string[]).join('\n'))}</pre>`
        : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; color: #1a1a1a; background: #fafafa; }
  main { max-width: 42rem; padding: 2rem; }
  h1 { font-size: 4rem; margin: 0; letter-spacing: -0.03em; }
  p { color: #555; margin: 0.5rem 0 0; }
  pre { margin-top: 1.5rem; padding: 1rem; overflow-x: auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 0.5rem; font-size: 0.8rem; color: #444; }
  @media (prefers-color-scheme: dark) {
    body { color: #f2f2f2; background: #131313; }
    p { color: #a0a0a0; }
    pre { background: #1c1c1c; border-color: #2a2a2a; color: #cfcfcf; }
  }
</style>
</head>
<body><main><h1>${status}</h1><p>${title}</p>${stack}</main></body>
</html>`
  }

  /** Headers an exception asked to be sent with it. */
  static headersOf(error: unknown): Record<string, string> {
    if (error instanceof HttpException) return error.headers

    // Duck-typed as well, so a package can carry headers without importing this.
    const candidate = (error as { headers?: unknown }).headers

    return candidate !== null && typeof candidate === 'object'
      ? (candidate as Record<string, string>)
      : {}
  }

  protected statusFor(error: unknown): number {
    /**
     * An exception that carries a response has that response's status.
     *
     * Asked first because nothing else can answer it: a `RedirectException` holds
     * a built `Response` and has no `status` of its own, so it fell through every
     * branch to the 500 at the bottom. Two things read that — the log, which
     * called an ordinary redirect an application failure, and the error hook,
     * which pins `set.status` from it.
     */
    if (carriesResponse(error)) return error[CARRIES_RESPONSE]().status

    if (error instanceof HttpException) return error.status

    // Elysia surfaces its own errors with a `status` or `code` field.
    const candidate = error as { status?: unknown; code?: unknown }
    if (typeof candidate?.status === 'number') return candidate.status
    if (candidate?.code === 'NOT_FOUND') return 404
    if (candidate?.code === 'VALIDATION') return 422
    if (candidate?.code === 'PARSE') return 400

    return 500
  }

  /**
   * The redirect a failed form gets, when something registered one.
   *
   * `validation.redirect` is bound by `@elvel/http`. It answers `undefined` for a
   * caller that wants JSON, which is what makes an API keep its 422.
   */
  protected sendBack(error: unknown, request: Request): Promise<Response> | undefined {
    const bag = schemaErrors(error)

    if (bag === undefined || !this.app.bound('validation.redirect')) return undefined

    const redirector = this.app.make('validation.redirect')
    const posted = (error as { value?: unknown }).value

    return redirector(bag, posted, request)
  }

  protected messageFor(error: unknown, status: number, debug: boolean): string {
    if (error instanceof HttpException) return error.message

    /**
     * A schema failure says so in a sentence, not in a schema dump.
     *
     * Elysia's `message` for one is a pretty-printed JSON object; it belongs in a
     * log, not in the space under a form field. The bag built by `schemaErrors`
     * carries the per-field detail, so all this has to be is the summary line —
     * and one that reads the same whether the client renders the bag or only this.
     */
    if ((error as { code?: unknown }).code === 'VALIDATION') {
      return 'The given data was invalid.'
    }

    if (status !== 500) {
      return ExceptionHandler.humanize(ExceptionHandler.messageOf(error))
    }

    if (debug && error instanceof Error) return error.message
    return 'Server Error'
  }

  /**
   * A field-keyed error bag, when the error exposes one.
   *
   * Duck-typed: core cannot depend on the validation package.
   */
  private static errorsOf(error: unknown): Record<string, string[]> | undefined {
    const bag = (error as { errors?: { messages?: unknown } }).errors

    if (
      bag &&
      typeof bag === 'object' &&
      typeof (bag as { messages?: unknown }).messages === 'function'
    ) {
      return (bag as { messages(): Record<string, string[]> }).messages()
    }

    return schemaErrors(error)
  }

  /**
   * Read a message off anything throwable. Plugins throw plain objects as often
   * as Errors, and `String(object)` would render "[object Object]".
   */
  static messageOf(error: unknown): string {
    if (error instanceof Error) return error.message

    if (typeof error === 'object' && error !== null) {
      const candidate = error as { message?: unknown; code?: unknown }
      if (typeof candidate.message === 'string') return candidate.message
      if (typeof candidate.code === 'string') return candidate.code
      return ''
    }

    return String(error)
  }

  /**
   * Elysia and its plugins throw machine codes (`NOT_FOUND`, `VALIDATION`).
   * Turn those into prose so responses don't leak internal identifiers.
   */
  private static humanize(message: string): string {
    if (!/^[A-Z][A-Z0-9_]*$/.test(message)) return message

    return message
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
}

/**
 * Did the client ask for HTML *before* JSON?
 *
 * A browser sends `text/html` ahead of everything; an API client sends
 * `application/json`, or a wildcard. Checking the order rather than mere presence is
 * what keeps a fetch() from being handed an error page it cannot parse.
 */
export function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''

  if (!accept.includes('text/html')) return false

  const json = accept.indexOf('application/json')

  return json === -1 || accept.indexOf('text/html') < json
}

/** Enough escaping for a message that may carry a path or a class name. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Elysia's own validation failure, as a bag a form can render.
 *
 * `Route.validate({ body: t.Object(…) })` fails with Elysia's `ValidationError`,
 * whose `message` is a pretty-printed JSON dump of the schema, the value and the
 * violation. Without this that dump *is* the answer — measured, a sign-up form
 * with a field missing showed the person
 * `{\n  "type": "validation",\n  "on": "body",\n  "property": "/password"…`
 * and no field was marked at all, because there was no bag to mark it from.
 *
 * Duck-typed on `code` and `all`, like everything else here: core cannot depend
 * on Elysia. `all` is one entry per violation, and `path` is a JSON pointer —
 * `/password`, or `/address/city` for a nested object — so it becomes a dotted
 * field name, which is what a bag is keyed by everywhere else.
 */
export function schemaErrors(error: unknown): Record<string, string[]> | undefined {
  const candidate = error as { code?: unknown; all?: unknown }

  if (candidate.code !== 'VALIDATION' || !Array.isArray(candidate.all)) return undefined

  const bag: Record<string, string[]> = {}

  for (const violation of candidate.all as Array<Record<string, unknown>>) {
    const pointer = typeof violation.path === 'string' ? violation.path : ''
    const field = pointer.replace(/^\//, '').replace(/\//g, '.')

    /**
     * A violation with no path is about the whole body.
     *
     * Elysia reports one when the body is not an object at all. Keyed under the
     * empty string it would mark no field and render nowhere, so it goes under
     * the name a form uses for its own summary.
     */
    const key = field === '' ? 'form' : field
    const said = sayViolation(field, violation)

    bag[key] = [...(bag[key] ?? []), said]
  }

  return Object.keys(bag).length > 0 ? bag : undefined
}

/**
 * One violation, as a sentence rather than as a schema assertion.
 *
 * Three cases carry almost all of them, and each reads badly unchanged:
 * `Expected required property`, a length bound, and a `format`. Anything else
 * falls through to Elysia's own `summary`, which names the field and is at least
 * a sentence — better than inventing prose for a rule this cannot see.
 */
function sayViolation(field: string, violation: Record<string, unknown>): string {
  const name = field === '' ? 'value' : field.split('.').pop()
  const message = typeof violation.message === 'string' ? violation.message : ''
  const summary = typeof violation.summary === 'string' ? violation.summary : message

  /**
   * Absent or blank, whatever rule it was going to fail.
   *
   * Elysia words a missing property as the type it wanted — `Expected string`,
   * with the summary `Expected property 'password' to be string but found:
   * undefined`. Measured: that summary reached a sign-up form, and "found:
   * undefined" is a sentence about the program rather than about what somebody
   * typed.
   *
   * The empty string is here for consistency, and it is the commonest case of
   * all: somebody submits a blank form. `format: 'email'` fails it before any
   * length rule, so the email field said "is not valid" while the name and
   * password beside it said "is required" — three empty inputs, two different
   * explanations.
   */
  if (violation.value === undefined || violation.value === '') {
    return `The ${name} field is required.`
  }

  if (/required property/i.test(message)) return `The ${name} field is required.`

  if (/minimum length|greater or equal|too short/i.test(message)) {
    /**
     * A bound of one means "say something", not "say more".
     *
     * `t.String({ minLength: 1 })` is how a schema refuses a blank field, and
     * "too short" for a field somebody left empty reads as though they had tried.
     */
    const schema = violation.schema as { minLength?: unknown } | undefined

    if (schema?.minLength === 1) return `The ${name} field is required.`

    return `The ${name} field is too short.`
  }

  if (/maximum length|lower or equal|too long/i.test(message)) {
    return `The ${name} field is too long.`
  }

  if (/format|pattern/i.test(message)) return `The ${name} field is not valid.`

  return summary === '' ? `The ${name} field is not valid.` : summary
}
