import { CARRIES_RESPONSE } from '@elvel/core'

/**
 * A redirect thrown rather than returned.
 *
 * Validation happens inside a handler, several frames from where a `Response`
 * could be returned — `validateRequest(...)` is a call, not a middleware. Throwing
 * is what lets a failure leave from wherever it is discovered, and it puts the
 * browser branch on the same path as the 422, so a handler cannot deal with one
 * and forget the other.
 *
 * The response is **built before the throw**, which is the part that matters:
 * `onAfterHandle` is what saves the session, and it does not run on the error
 * path. A redirect that flashed its errors and then let nobody persist them
 * arrives at a form with no messages and no input — which is what happened the
 * first time this was driven over the network, and why the flashing and the saving
 * both belong on this side of the `throw`.
 */
export class RedirectException extends Error {
  constructor(
    private readonly response: Response,
    location: string
  ) {
    super(`Redirecting to ${location}`)
    this.name = 'RedirectException'
  }

  /**
   * Read by the exception handler, which sends this instead of rendering.
   *
   * Keyed by a symbol rather than a plain `toResponse` method: Elysia's own error
   * classes have one of those, so recognising the contract by shape made the
   * handler answer every framework error with Elysia's response instead of ours.
   */
  [CARRIES_RESPONSE](): Response {
    return this.response
  }
}
