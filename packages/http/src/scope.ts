import { AsyncLocalStorage } from 'node:async_hooks'
import type { Session } from './session.ts'

export type RequestScope = {
  request: Request
  session: Session
}

const storage = new AsyncLocalStorage<RequestScope>()

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
  return storage.getStore()
}

/**
 * Enter the scope for the rest of this request.
 *
 * `enterWith`, and it **must** be called from a synchronous hook.
 * `AsyncLocalStorage.enterWith` applies to the remainder of the current execution;
 * an `await` restores the frame its continuation was scheduled with, so entering
 * from an async `derive` is already lost by the time the handler runs. The auth
 * package learned this the same way, and there is a test for the arrangement in
 * both places.
 */
export function enterRequestScope(scope: RequestScope): void {
  storage.enterWith(scope)
}

/** Run `body` inside a scope. For tests, and for anything not in a hook. */
export function withRequestScope<T>(scope: RequestScope, body: () => T): T {
  return storage.run(scope, body)
}
