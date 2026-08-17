import { app, ForbiddenException } from '@elvel/core'
import { Arr } from '@elvel/support'
import {
  type Data,
  ErrorBag,
  extendRules,
  type PresenceVerifier,
  type RuleDeclaration,
  ValidationError,
  Validator
} from '@elvel/validation'
import { redirect } from './redirect.ts'
import { RedirectException } from './redirect-exception.ts'

export type RequestContext = {
  body?: unknown
  query?: Record<string, unknown>
  params?: Record<string, unknown>
  headers?: Record<string, string | undefined>
  request?: Request
}

/**
 * Phase two of validation, bound to a request.
 *
 * The lifecycle is `ValidatesWhenResolvedTrait::validateResolved()`, in order:
 *
 * 1. `prepareForValidation()` — normalise the payload before anything reads it
 * 2. `authorize()` — a 403, not a 422; failing here must not leak which fields
 *    would have been invalid
 * 3. the rules run, through the same `Validator` a command or seeder would use
 * 4. `failedValidation()` on failure — 422 by default
 * 5. `passedValidation()` — last chance to derive values
 *
 * Phase one (shape and type) belongs to the Elysia route schema and has already
 * run by the time a handler resolves this.
 */
export abstract class FormRequest {
  /** Stop at the first failing field. */
  static stopOnFirstFailure = false

  /** Reject keys the rules never mention, instead of ignoring them. */
  static failOnUnknownFields = false

  protected data: Data = {}
  protected validator?: Validator
  private validatedData?: Data

  constructor(
    protected readonly context: RequestContext = {},
    private readonly verifier?: PresenceVerifier
  ) {}

  /** The rules to apply. */
  abstract rules(): Record<string, RuleDeclaration>

  /** Return false, or throw, to refuse the request with a 403. */
  authorize(): boolean | Promise<boolean> {
    return true
  }

  /** Custom messages, keyed by `rule` or `field.rule`. */
  messages(): Record<string, string> {
    return {}
  }

  /** Friendlier names for fields in messages. */
  attributes(): Record<string, string> {
    return {}
  }

  /** Adjust the payload before validation — trim, cast, merge defaults. */
  prepareForValidation(): void | Promise<void> {}

  /** Runs once validation succeeded. */
  passedValidation(): void | Promise<void> {}

  /** Hook the validator itself, for `after()` callbacks and conditional rules. */
  withValidator(_validator: Validator): void {}

  /** What gets validated. Body, query and route params, in that precedence. */
  validationData(): Data {
    const body = isPlainObject(this.context.body) ? this.context.body : {}

    return {
      ...(this.context.params ?? {}),
      ...(this.context.query ?? {}),
      ...body
    }
  }

  /**
   * Run the whole lifecycle. Throws `ForbiddenException` or `ValidationError`.
   */
  async validateResolved(): Promise<Data> {
    this.data = this.validationData()

    await this.prepareForValidation()

    if (!(await this.authorize())) this.failedAuthorization()

    const validator = this.makeValidator()
    this.validator = validator

    this.withValidator(validator)

    const self = this.constructor as typeof FormRequest

    if (self.failOnUnknownFields) {
      validator.after((instance) => {
        // Reported as an error rather than thrown, so it joins the same bag.
        for (const key of this.unknownFields()) {
          instance.addError(key, `The ${key} field is not allowed.`)
        }
      })
    }

    if (await validator.fails()) await this.failedValidation(validator)

    this.validatedData = validator.validated()

    await this.passedValidation()

    return this.validatedData
  }

  protected makeValidator(): Validator {
    const self = this.constructor as typeof FormRequest

    return new Validator(this.data, this.rules(), {
      messages: this.messages(),
      attributes: this.attributes(),
      stopOnFirstFailure: self.stopOnFirstFailure,
      verifier: this.verifier ?? FormRequest.containerVerifier()
    })
  }

  /**
   * The application's presence verifier, so `unique`/`exists` work without every
   * caller threading one in — Laravel gets this from the container's validator
   * factory. Absent when the validation provider isn't registered, or when the
   * app has no database; the rules themselves raise a clear error then.
   */
  private static containerVerifier(): PresenceVerifier | undefined {
    try {
      const instance = app()

      return instance.bound('validation.verifier')
        ? (instance.make('validation.verifier') as PresenceVerifier | undefined)
        : undefined
    } catch {
      // No application booted — a unit test constructing a request by hand.
      return undefined
    }
  }

  /** Keys present in the payload that no rule mentions. */
  protected unknownFields(): string[] {
    const known = new Set(Object.keys(this.rules()).map((rule) => rule.split('.')[0]))

    return Object.keys(this.data).filter((key) => !known.has(key))
  }

  protected failedAuthorization(): never {
    throw new ForbiddenException('This action is unauthorized.')
  }

  /**
   * What a failure looks like.
   *
   * A browser posting a form wants to be sent back to it, with the messages and
   * what it typed; an API client wants the 422 with the bag. Laravel decides this
   * in the exception handler with `expectsJson()`; here the request request itself
   * decides, and the redirect is *thrown* so it travels the same path as the 422 —
   * a handler that never sees the difference cannot get it wrong.
   */
  protected async failedValidation(validator: Validator): Promise<never> {
    if (this.expectsJson()) throw new ValidationError(validator.errors)

    const back = redirect().back().withErrors(validator.errors).withInput(this.data)

    // Persisted here, before the throw: nothing saves the session on the error
    // path. See RedirectException.
    throw new RedirectException(await back.toResponse(true), back.location)
  }

  /**
   * Does this caller want JSON, or is it a browser posting a form?
   *
   * Getting this wrong is not cosmetic in either direction — an API would receive
   * a 302 it cannot follow, and a form would receive a 422 it cannot show — so the
   * decision reads four signals rather than one:
   *
   * 1. `X-Requested-With: XMLHttpRequest` — how a `fetch()` from a page says it is
   *    not navigating.
   * 2. `Accept` naming JSON.
   * 3. A **JSON request body**. A browser form posts `x-www-form-urlencoded` or
   *    `multipart/form-data` and can post nothing else; anything sending JSON is a
   *    client. This is the signal that was missing when the playground's API routes
   *    started being redirected instead of answered.
   * 4. No `Accept` at all, which no browser omits.
   *
   * Otherwise: a caller that accepts HTML — or anything, `*&#47;*` — is treated as a
   * browser, which is Laravel's reading too.
   */
  protected expectsJson(): boolean {
    const headers = this.context.headers ?? {}
    const header = (name: string) => headers[name] ?? this.context.request?.headers.get(name) ?? ''

    if (header('x-requested-with').toLowerCase() === 'xmlhttprequest') return true

    const accept = header('accept')
    if (accept.includes('application/json')) return true

    if (header('content-type').includes('application/json')) return true

    if (accept === '') return true

    return !accept.includes('text/html') && !accept.includes('*/*')
  }

  /** The validated payload. Available after `validateResolved()`. */
  validated(): Data {
    if (!this.validatedData) {
      throw new Error('Call validateResolved() before validated().')
    }

    return this.validatedData
  }

  /** Subsets of the validated payload, as Laravel's `safe()` returns. */
  safe(): {
    all(): Data
    only(...keys: string[]): Data
    except(...keys: string[]): Data
  } {
    const data = this.validated()

    return {
      all: () => ({ ...data }),
      only: (...keys: string[]) => {
        const result: Data = {}
        for (const key of keys.flat()) {
          if (Arr.has(data, key)) Arr.set(result, key, Arr.get(data, key))
        }
        return result
      },
      except: (...keys: string[]) => {
        const result = { ...data }
        for (const key of keys.flat()) delete result[key]
        return result
      }
    }
  }

  get errors(): ErrorBag {
    return this.validator?.errors ?? new ErrorBag()
  }

  /** Read a raw input value, validated or not. */
  input<T = unknown>(key: string, fallback?: T): T {
    return Arr.get(this.data, key, fallback as T)
  }

  has(key: string): boolean {
    return Arr.has(this.data, key)
  }

  /** Merge values into the payload, for use from `prepareForValidation`. */
  merge(values: Data): this {
    Object.assign(this.data, values)
    return this
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve a form request inside a handler.
 *
 * ```ts
 * .post('/users', async (context) => {
 *   const data = await validateRequest(StoreUserRequest, context)
 * })
 * ```
 */
export async function validateRequest<T extends FormRequest>(
  request: new (context: RequestContext, verifier?: PresenceVerifier) => T,
  context: RequestContext,
  verifier?: PresenceVerifier
): Promise<Data> {
  return new request(context, verifier).validateResolved()
}

/**
 * `current_password` — the value must be the signed-in user's password.
 *
 * A request-scoped question, which is why it lives here rather than in the
 * validator: the standalone validator has no session and no user, and a rule
 * that silently passed without one would be worse than no rule at all — it
 * guards password changes and account deletion.
 *
 * Verification goes to better-auth, because it owns the hash and the algorithm
 * it was written with. Register it once, in a provider:
 *
 * ```ts
 * registerCurrentPasswordRule(this.app)
 * ```
 */
export function registerCurrentPasswordRule(app: {
  bound(key: never): boolean
  make(key: never): unknown
}): void {
  extendRules('current_password', async ({ value }: { value: unknown }) => {
    if (typeof value !== 'string' || value === '') return false
    if (!app.bound('auth' as never)) return false

    const manager = app.make('auth' as never) as {
      user(): { email?: string } | null
      instance: { api: { signInEmail(args: unknown): Promise<unknown> } }
    }

    const user = manager.user()

    if (!user?.email) return false

    try {
      /**
       * Verified by signing in with it, which is the only check better-auth
       * exposes that does not need the hash.
       *
       * `asResponse` keeps the new session's cookie out of the reply — this is a
       * check, not a login, and issuing a second session as a side effect of
       * validating a form would be a surprise nobody asked for.
       */
      const response = (await manager.instance.api.signInEmail({
        body: { email: user.email, password: value },
        asResponse: true
      })) as Response

      return response.ok
    } catch {
      return false
    }
  })
}
