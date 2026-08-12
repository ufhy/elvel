import { ForbiddenException } from '@elysian/core'
import { Arr } from '@elysian/support'
import {
  type Data,
  ErrorBag,
  type PresenceVerifier,
  type RuleDeclaration,
  ValidationError,
  Validator
} from '@elysian/validation'

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

    if (await validator.fails()) this.failedValidation(validator)

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
      verifier: this.verifier
    })
  }

  /** Keys present in the payload that no rule mentions. */
  protected unknownFields(): string[] {
    const known = new Set(Object.keys(this.rules()).map((rule) => rule.split('.')[0]))

    return Object.keys(this.data).filter((key) => !known.has(key))
  }

  protected failedAuthorization(): never {
    throw new ForbiddenException('This action is unauthorized.')
  }

  protected failedValidation(validator: Validator): never {
    throw new ValidationError(validator.errors)
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
