/**
 * The outcome of an authorization check, carrying a message and a status.
 *
 * A bare boolean cannot explain *why* a check failed, which is the whole point
 * of `Illuminate\Auth\Access\Response`: a policy returns one when the denial
 * needs a reason, or a status other than 403.
 */
export class AuthorizationResponse {
  constructor(
    private readonly isAllowed: boolean,
    readonly message = '',
    readonly code?: string
  ) {}

  private httpStatus?: number

  static allow(message?: string, code?: string): AuthorizationResponse {
    return new AuthorizationResponse(true, message ?? '', code)
  }

  static deny(message?: string, code?: string): AuthorizationResponse {
    return new AuthorizationResponse(false, message ?? 'This action is unauthorized.', code)
  }

  /** Deny with a status other than 403. */
  static denyWithStatus(status: number, message?: string, code?: string): AuthorizationResponse {
    return AuthorizationResponse.deny(message, code).withStatus(status)
  }

  /**
   * Deny as a 404.
   *
   * Hiding a resource's existence is often the point: a 403 on a record the
   * viewer may not see already tells them it exists.
   */
  static denyAsNotFound(message?: string, code?: string): AuthorizationResponse {
    return AuthorizationResponse.denyWithStatus(404, message ?? 'Not Found', code)
  }

  allowed(): boolean {
    return this.isAllowed
  }

  denied(): boolean {
    return !this.isAllowed
  }

  withStatus(status: number): this {
    this.httpStatus = status
    return this
  }

  asNotFound(): this {
    return this.withStatus(404)
  }

  /** The status this response should be rendered with, when denied. */
  status(): number | undefined {
    return this.isAllowed ? undefined : (this.httpStatus ?? 403)
  }

  /** Throw unless the check passed, as Laravel's `Response::authorize()` does. */
  authorize(): this {
    if (this.denied()) {
      throw new AuthorizationError(this.message, this.status() ?? 403, this.code)
    }

    return this
  }

  toObject(): { allowed: boolean; message: string; code?: string } {
    return { allowed: this.isAllowed, message: this.message, code: this.code }
  }

  toString(): string {
    return this.message
  }
}

/**
 * Thrown by `Gate.authorize()`. Carries its own status so the framework's
 * exception handler renders it without knowing about the auth package.
 */
export class AuthorizationError extends Error {
  constructor(
    message = 'This action is unauthorized.',
    readonly status = 403,
    readonly code?: string
  ) {
    super(message)
    this.name = 'AuthorizationError'
  }

  /** The response this exception represents, mirroring `toResponse()`. */
  toResponse(): AuthorizationResponse {
    return AuthorizationResponse.deny(this.message, this.code).withStatus(this.status)
  }
}
