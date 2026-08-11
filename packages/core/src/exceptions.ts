import type { ApplicationContract, ExceptionHandlerContract } from '@elysian/contracts'

/**
 * Base class for exceptions that carry their own HTTP response, mirroring
 * Laravel's `HttpException` family.
 */
export class HttpException extends Error {
  constructor(
    readonly status: number,
    message?: string
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
    console.error(error)
  }

  render(error: unknown, _context: { request: Request }): Response {
    const status = this.statusFor(error)
    const debug = this.app.hasDebugModeEnabled()

    const payload: Record<string, unknown> = {
      message: this.messageFor(error, status, debug)
    }

    if (debug && error instanceof Error) {
      payload.exception = error.name
      payload.stack = error.stack?.split('\n').map((line) => line.trim())
    }

    return Response.json(payload, { status })
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
   * Read a message off anything throwable. Plugins throw plain objects as often
   * as Errors, and `String(object)` would render "[object Object]".
   */
  private static messageOf(error: unknown): string {
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
