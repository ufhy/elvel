import type { ApplicationContract, ExceptionHandlerContract } from '@elysian/contracts'

/**
 * Base class for exceptions that carry their own HTTP response, mirroring
 * Laravel's `HttpException` family.
 */
/**
 * Marks an exception that carries its own finished `Response`.
 *
 * A symbol, and `Symbol.for` so two copies of this package agree on it. Core
 * cannot import `@elysian/http`, and this is the whole contract between them.
 */
export const CARRIES_RESPONSE: unique symbol = Symbol.for(
  'elysian.carriesResponse'
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

  report(error: unknown): void {
    if (this.app.environment() === 'testing') return

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

  render(error: unknown, _context: { request: Request }): Response {
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

    return Response.json(payload, { status, headers: ExceptionHandler.headersOf(error) })
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
    if (error instanceof HttpException) return error.status

    // Elysia surfaces its own errors with a `status` or `code` field.
    const candidate = error as { status?: unknown; code?: unknown }
    if (typeof candidate?.status === 'number') return candidate.status
    if (candidate?.code === 'NOT_FOUND') return 404
    if (candidate?.code === 'VALIDATION') return 422
    if (candidate?.code === 'PARSE') return 400

    return 500
  }

  protected messageFor(error: unknown, status: number, debug: boolean): string {
    if (error instanceof HttpException) return error.message

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

    return undefined
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
