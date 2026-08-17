import { app } from '@elyvel/core'
import { BAGGED, DEFAULT_BAG, ERRORS_KEY, OLD_INPUT_KEY } from './errors.ts'
import { currentScope } from './scope.ts'

/** Session key holding where a guest was going before being sent to sign in. */
export const INTENDED_URL_KEY = 'url.intended'

/** Session key holding the previous URL, so `back()` works without a Referer. */
export const PREVIOUS_URL_KEY = '_previous.url'

/** Fields never written to the session, whatever a caller passes. */
const NEVER_FLASHED = ['password', 'password_confirmation', 'current_password', 'token']

/** Anything with a message bag — a validator, or a plain `{ field: [msg] }`. */
export type ErrorsInput =
  | { messages(): Record<string, string[]> }
  | Record<string, string[] | string>

/**
 * A redirect being built — Laravel's `RedirectResponse`.
 *
 * The flashing is the point. A redirect that loses what the user typed and why it
 * was refused is a redirect to a blank form, which is how a validation failure
 * turns into an abandoned form.
 *
 * Returned from a handler like any other `Response`:
 *
 * ```ts
 * return redirect().back().withErrors(validator.errors).withInput(body)
 * ```
 */
export class Redirect {
  private flashes: Array<[string, unknown]> = []

  constructor(
    private target: string,
    private status = 302,
    private readonly session = currentScope()?.session
  ) {}

  /** Flash one value for the next request only. */
  with(key: string, value: unknown): this {
    this.flashes.push([key, value])

    return this
  }

  /**
   * Flash the errors, merged with anything already there.
   *
   * Merged rather than replaced because two validators can fail in one request —
   * a form request and an `after()` check, say — and the second must not erase
   * what the first reported.
   */
  withErrors(errors: ErrorsInput, bag: string = DEFAULT_BAG): this {
    const incoming = normalise(errors)
    const existing = this.session?.get<Record<string, unknown>>(ERRORS_KEY) ?? {}

    if (bag === DEFAULT_BAG && !(BAGGED in existing)) {
      this.flashes.push([ERRORS_KEY, { ...existing, ...incoming }])

      return this
    }

    /**
     * Named bags are kept under a sentinel key rather than beside the fields.
     *
     * Two forms on one page each need their own errors — without that, a failed
     * sign-up lights up the sign-in form's inputs. The sentinel is what keeps a
     * field genuinely called `login` from being mistaken for a bag.
     */
    const bags = {
      ...((existing[BAGGED] as Record<string, Record<string, string[]>>) ?? {})
    }

    if (!(BAGGED in existing) && Object.keys(existing).length > 0) {
      bags[DEFAULT_BAG] = existing as Record<string, string[]>
    }

    bags[bag] = { ...(bags[bag] ?? {}), ...incoming }

    this.flashes.push([ERRORS_KEY, { [BAGGED]: bags }])

    return this
  }

  /**
   * Flash the submitted input, so the form comes back filled in.
   *
   * Files are dropped — a `File` cannot survive the session, and pretending it
   * did would hand the next request a broken object. Passwords are dropped too,
   * always: a rejected sign-up must not leave a password sitting in the session
   * store, and relying on every caller to remember that is how it ends up there.
   */
  withInput(input: unknown): this {
    this.flashes.push([OLD_INPUT_KEY, sanitise(input)])

    return this
  }

  /** Flash the input except these fields. */
  withoutInput(input: unknown, ...except: string[]): this {
    const clean = sanitise(input) as Record<string, unknown>

    for (const field of except) delete clean[field]

    this.flashes.push([OLD_INPUT_KEY, clean])

    return this
  }

  /**
   * Point back where the request came from.
   *
   * Chainable and explicit, so `redirect().back().withErrors(...)` reads as the
   * sentence it is — `redirect()` alone already resolves there, but a reader
   * should not have to know that to be sure.
   */
  back(): this {
    this.target = previousUrl()

    return this
  }

  /**
   * Send a guest to sign in, remembering where they were going.
   *
   * Only a GET is remembered. Storing the URL of a POST would send someone, after
   * signing in, to an address that only answers a form submission — a 405, or
   * worse a repeated action.
   */
  guest(): this {
    const scope = currentScope()
    const request = scope?.request

    if (request && request.method === 'GET') {
      const url = new URL(request.url)

      scope?.session.put(INTENDED_URL_KEY, url.pathname + url.search)
    }

    return this
  }

  /** 301 rather than 302, for a move that is meant to be remembered. */
  permanent(): this {
    this.status = 301

    return this
  }

  /**
   * Go to a named route — `redirect().route('articles.show', { id })`.
   *
   * The point of naming: this line survives the path changing, and fails at boot
   * rather than at a user's click if the name stops matching one.
   */
  route(name: string, parameters: Record<string, unknown> = {}): this {
    this.target = app('routes').to(name, parameters)

    return this
  }

  /** 303, which turns a POST into a GET — the right answer after a form. */
  seeOther(): this {
    this.status = 303

    return this
  }

  /** Where this redirect points, after any `back()` resolution. */
  get location(): string {
    return this.target
  }

  /**
   * Build the response, writing the flashes into the session first.
   *
   * `persist` defaults to **false**, and both halves of that are load-bearing:
   *
   * - A redirect *returned* from a handler is followed by `onAfterHandle`, which
   *   saves. Saving here as well ages the flash twice — the first save promotes
   *   `_flash.new` to `_flash.old`, the second deletes it — so the value is gone
   *   before the next request can read it. That is a flash that silently never
   *   arrives, and it is what the first version of this did.
   * - A redirect *thrown* from validation goes to `onError`, where no hook saves
   *   anything. That path passes `true`, because otherwise the errors and the old
   *   input are written to an object nobody persists and the form comes back blank.
   *
   * Both were found by driving the form over the network rather than by reading it.
   */
  async toResponse(persist = false): Promise<Response> {
    for (const [key, value] of this.flashes) this.session?.flash(key, value)

    if (persist) await this.session?.save()

    return new Response(null, { status: this.status, headers: { location: this.target } })
  }

  /**
   * Elysia sends whatever a handler returns; being a `Response` is not enough
   * when a caller returns the builder itself, so it converts on demand.
   */
  toJSON(): { redirect: string } {
    return { redirect: this.target }
  }
}

/**
 * `redirect('/articles')`, or `redirect().back()`.
 *
 * The no-argument form exists so `back()` reads as the sentence it is.
 */
export function redirect(to?: string, status = 302): Redirect {
  return new Redirect(to ?? previousUrl(), status)
}

/** Where the last request came from: the stored URL, then `Referer`, then `/`. */
export function previousUrl(): string {
  const scope = currentScope()

  const stored = scope?.session.get<string>(PREVIOUS_URL_KEY)
  if (stored) return stored

  // A Referer can be stripped by a proxy or withheld by the browser, which is why
  // Laravel keeps its own copy — and why this prefers the stored one.
  const referer = scope?.request.headers.get('referer')

  return referer ?? '/'
}

/**
 * Go where the guest was originally going — `redirect()->intended()`.
 *
 * Pulled rather than read: an intended URL is used once, and leaving it behind
 * would send the *next* sign-in somewhere the person had forgotten about.
 */
export function intended(fallback = '/', status = 302): Redirect {
  const scope = currentScope()
  const target = scope?.session.get<string>(INTENDED_URL_KEY)

  scope?.session.forget(INTENDED_URL_KEY)

  return new Redirect(target ?? fallback, status)
}

/** `back()` as a standalone helper, for a handler that only needs the redirect. */
export function back(status = 302): Redirect {
  return new Redirect(previousUrl(), status)
}

function normalise(errors: ErrorsInput): Record<string, string[]> {
  if (typeof (errors as { messages?: unknown }).messages === 'function') {
    return (errors as { messages(): Record<string, string[]> }).messages()
  }

  const entries = Object.entries(errors as Record<string, string[] | string>)

  return Object.fromEntries(
    entries.map(([key, value]) => [key, Array.isArray(value) ? value : [value]])
  )
}

/** Drop uploads and secrets, at every depth. */
function sanitise(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((entry) => sanitise(entry))

  if (input === null || typeof input !== 'object') return input
  if (typeof File !== 'undefined' && input instanceof File) return undefined
  if (input instanceof Blob) return undefined

  const clean: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (NEVER_FLASHED.includes(key)) continue

    const cleaned = sanitise(value)
    if (cleaned !== undefined) clean[key] = cleaned
  }

  return clean
}
