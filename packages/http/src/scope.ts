import { requestSlot } from '@elvel/core'
import type { Session } from './session.ts'

export type RequestScope = {
  request: Request
  session: Session

  /**
   * This response's CSP nonce, when a policy is being sent.
   *
   * Here rather than threaded through props for the same reason `errors()` is: a
   * view is a component, and an inline script three components deep still has to
   * carry the nonce or the browser refuses to run it.
   */
  nonce?: string
}

const slot = requestSlot<RequestScope>('request-scope')

/**
 * The current request's session, reachable without threading it through.
 *
 * This exists for one reason: a view here is a JSX component, not a template with
 * a scope somebody can share `$errors` into. Laravel's `ShareErrorsFromSession`
 * has a variable bag to write to; a component has props, and threading errors and
 * old input through every component between the handler and the input that needs
 * them is exactly the plumbing that makes people give up and skip validation
 * feedback.
 *
 * So `errors()` and `old()` read the scope instead, and work anywhere inside a
 * request — including three components deep.
 */
export function currentScope(): RequestScope | undefined {
  return slot.get()
}

/**
 * Enter the scope for the rest of this request.
 *
 * A slot in the one request context — see `request-context.ts` for why there is
 * only one now. It **must** still be reached from a synchronous hook:
 * `AsyncLocalStorage.enterWith` applies to the remainder of the current
 * execution, and an `await` restores the frame its continuation was scheduled
 * with, so entering from an async `derive` is already lost by the time the
 * handler runs. The auth package learned this the same way, and there is a test
 * for the arrangement in both places.
 */
export function enterRequestScope(scope: RequestScope): void {
  slot.set(scope)
}

/** Run `body` inside a scope. For tests, and for anything not in a hook. */
export function withRequestScope<T>(scope: RequestScope, body: () => T): T {
  return slot.run(scope, body)
}

/**
 * The nonce a `<script>` in this response must carry.
 *
 * ```tsx
 * <script nonce={cspNonce()}>{theme}</script>
 * ```
 *
 * Empty when no policy is being sent, which makes the attribute inert rather than
 * wrong — a page written this way works with the policy off and with it on.
 */
export function cspNonce(): string {
  return currentScope()?.nonce ?? ''
}
