import { Arr } from '@elysian/support'
import { ErrorBag } from './error-bag.ts'
import { humanizeAttribute, interpolate, resolveMessage, typeOf } from './messages.ts'
import {
  DEPENDENT_RULES,
  EXCLUDE_RULES,
  IMPLICIT_RULES,
  isFilled,
  NON_VALIDATING_RULES,
  RULES,
  SIZE_RULES
} from './rules.ts'
import {
  type Data,
  DatabaseRule,
  type ParsedRule,
  type PresenceVerifier,
  type RuleContext,
  type RuleDeclaration,
  type Rules,
  type ValidatorOptions
} from './types.ts'

export class ValidationError extends Error {
  constructor(readonly errors: ErrorBag) {
    super(errors.first() ?? 'The given data was invalid.')
    this.name = 'ValidationError'
  }
}

/**
 * Rule-based validation, phase two of the framework's two-phase story.
 *
 * Phase one is TypeBox: shape, type and format, checked synchronously by
 * Elysia before a handler runs. This is everything TypeBox cannot express —
 * anything asynchronous (`unique`, `exists`) and anything that reads another
 * field (`confirmed`, `required_if`, and the two dozen others).
 *
 * The execution model follows `Illuminate\Validation\Validator::passes()`
 * exactly, because the details are what make error bags readable:
 *
 * - a rule runs only if the value is present or the rule is *implicit*
 * - `nullable` skips non-implicit rules for a null value
 * - `sometimes` skips everything when the key is absent
 * - validation for an attribute stops after `bail`, and stops automatically
 *   once an implicit rule fails, so an empty field reports "required" alone
 *   rather than also "min" and "email"
 * - `exclude*` rules remove the attribute from `validated()` instead of failing
 */
export class Validator {
  private readonly rules: Record<string, ParsedRule[]> = {}
  private readonly afterCallbacks: Array<(validator: Validator) => void | Promise<void>> = []
  private readonly excluded = new Set<string>()
  readonly errors = new ErrorBag()

  private ran = false

  constructor(
    private readonly data: Data,
    rules: Rules,
    private readonly options: ValidatorOptions = {}
  ) {
    for (const [attribute, declaration] of Object.entries(rules)) {
      this.rules[attribute] = Validator.parse(declaration)
    }
  }

  /** `'required|min:3'`, an array, or a rule object. */
  static parse(declaration: RuleDeclaration): ParsedRule[] {
    const list = Array.isArray(declaration)
      ? declaration
      : typeof declaration === 'string'
        ? declaration.split('|')
        : [declaration]

    return list.flatMap((entry) => {
      if (entry instanceof DatabaseRule) {
        return [{ name: entry.name, params: [], rule: entry }]
      }

      const trimmed = String(entry).trim()
      if (trimmed === '') return []

      const separator = trimmed.indexOf(':')
      const name = separator === -1 ? trimmed : trimmed.slice(0, separator)
      const params =
        separator === -1
          ? []
          : trimmed
              .slice(separator + 1)
              .split(',')
              .map((param) => param.trim())

      return [{ name: name.trim(), params }]
    })
  }

  /** Register a callback that can add errors after the rules have run. */
  after(callback: (validator: Validator) => void | Promise<void>): this {
    this.afterCallbacks.push(callback)
    return this
  }

  /** Add an error by hand, from an `after` callback or a controller. */
  addError(attribute: string, message: string): this {
    this.errors.add(attribute, message)
    return this
  }

  async passes(): Promise<boolean> {
    if (this.ran) return this.errors.isEmpty()
    this.ran = true

    for (const [attribute, rules] of Object.entries(this.rules)) {
      if (this.options.stopOnFirstFailure && this.errors.isNotEmpty()) break
      if (this.excluded.has(attribute)) continue

      for (const rule of rules) {
        const passed = await this.runRule(attribute, rule, rules)

        // An excluded attribute is not validated at all: its remaining rules
        // describe a value that will never reach `validated()`.
        if (this.excluded.has(attribute)) break

        if (passed) continue

        // Stop this attribute when `bail` is set, or when an implicit rule
        // failed: reporting "min" on an absent value is noise.
        if (this.shouldStopValidating(attribute, rules)) break
      }
    }

    for (const callback of this.afterCallbacks) await callback(this)

    return this.errors.isEmpty()
  }

  async fails(): Promise<boolean> {
    return !(await this.passes())
  }

  /** The validated data, or a ValidationError carrying the bag. */
  async validate(): Promise<Data> {
    if (!(await this.passes())) throw new ValidationError(this.errors)

    return this.validated()
  }

  /**
   * Only the attributes that were validated, with excluded ones removed.
   *
   * Returning the whole payload would let an unvalidated field reach a database
   * write, which is the entire point of validating first.
   */
  validated(): Data {
    const result: Data = {}

    for (const attribute of Object.keys(this.rules)) {
      if (this.excluded.has(attribute)) continue
      if (!Arr.has(this.data, attribute)) continue

      Arr.set(result, attribute, Arr.get(this.data, attribute))
    }

    return result
  }

  /**
   * Run one rule, returning whether validation should continue for this
   * attribute. Records a failure when the rule does not pass.
   */
  private async runRule(
    attribute: string,
    rule: ParsedRule,
    siblings: ParsedRule[]
  ): Promise<boolean> {
    if (NON_VALIDATING_RULES.has(rule.name) && !EXCLUDE_RULES.has(rule.name)) return true

    const value = Arr.get(this.data, attribute)

    if (EXCLUDE_RULES.has(rule.name)) {
      if (await this.shouldExclude(attribute, rule, siblings)) this.excluded.add(attribute)
      return true
    }

    if (!this.isValidatable(attribute, rule, value, siblings)) return true

    const handler = RULES[rule.name]

    if (!handler) {
      throw new Error(`Validation rule [${rule.name}] does not exist.`)
    }

    const context: RuleContext = {
      attribute,
      value,
      params: rule.params,
      data: this.data,
      rule: rule.rule,
      siblings,
      verifier: this.options.verifier
    }

    if (await handler(context)) return true

    this.addFailure(attribute, rule, value, siblings)

    return false
  }

  /** The `exclude*` family, which drops the attribute rather than failing it. */
  private async shouldExclude(
    attribute: string,
    rule: ParsedRule,
    siblings: ParsedRule[]
  ): Promise<boolean> {
    const [field, ...values] = rule.params
    const other = field === undefined ? undefined : Arr.get(this.data, field)

    switch (rule.name) {
      case 'exclude':
        return true
      case 'exclude_if':
        return values.includes(String(other))
      case 'exclude_unless':
        return !values.includes(String(other))
      case 'exclude_with':
        return isFilled(other)
      case 'exclude_without':
        return !isFilled(other)
      default:
        void siblings
        void attribute
        return false
    }
  }

  /**
   * The gate from `Validator::isValidatable`.
   *
   * A whitespace-only string counts as absent, which is why `'   '` fails
   * `required` but does not also fail `email`.
   */
  private isValidatable(
    attribute: string,
    rule: ParsedRule,
    value: unknown,
    siblings: ParsedRule[]
  ): boolean {
    const implicit = IMPLICIT_RULES.has(rule.name)

    // `sometimes`: nothing runs unless the key was sent.
    if (this.hasRule(siblings, 'sometimes') && !Arr.has(this.data, attribute)) return false

    // `nullable`: an explicit null skips everything but the implicit rules.
    if (this.hasRule(siblings, 'nullable') && value === null && !implicit) return false

    if (typeof value === 'string' && value.trim() === '') return implicit

    return isFilled(value) || implicit
  }

  private shouldStopValidating(attribute: string, siblings: ParsedRule[]): boolean {
    if (this.hasRule(siblings, 'bail')) return this.errors.has(attribute)

    // An implicit failure means the value was absent; later rules would only
    // restate that.
    return this.errors.failedImplicit(attribute)
  }

  private hasRule(rules: ParsedRule[], name: string): boolean {
    return rules.some((rule) => rule.name === name)
  }

  private addFailure(
    attribute: string,
    rule: ParsedRule,
    value: unknown,
    siblings: ParsedRule[]
  ): void {
    const numeric = siblings.some((sibling) =>
      ['numeric', 'integer', 'decimal'].includes(sibling.name)
    )

    const type = SIZE_RULES.has(rule.name) ? typeOf(value, numeric) : 'string'
    const template = resolveMessage(rule.name, type, this.customMessagesFor(attribute))

    this.errors.add(
      attribute,
      interpolate(template, this.replacements(attribute, rule)),
      IMPLICIT_RULES.has(rule.name)
    )
  }

  /** `attribute.rule` beats `rule`, matching Laravel's message lookup order. */
  private customMessagesFor(attribute: string): Record<string, string> {
    const messages = this.options.messages ?? {}
    const scoped: Record<string, string> = {}

    for (const [key, message] of Object.entries(messages)) {
      const [target, rule] = key.split('.')

      if (rule === undefined) scoped[target as string] = message
      else if (target === attribute) scoped[rule] = message
    }

    return scoped
  }

  private replacements(attribute: string, rule: ParsedRule): Record<string, string> {
    const label = this.options.attributes?.[attribute] ?? humanizeAttribute(attribute)
    const [first, second] = rule.params

    const otherField = DEPENDENT_RULES.has(rule.name) ? first : undefined
    const otherLabel =
      otherField === undefined
        ? ''
        : (this.options.attributes?.[otherField] ?? humanizeAttribute(otherField))

    return {
      attribute: label,
      other: otherLabel,
      value:
        rule.name.endsWith('_if') || rule.name.endsWith('_unless')
          ? rule.params.slice(1).join(', ')
          : String(first ?? ''),
      values: rule.params
        .map((param) => (DEPENDENT_RULES.has(rule.name) ? humanizeAttribute(param) : param))
        .join(', '),
      min: String(first ?? ''),
      max: String(second ?? ''),
      size: String(first ?? ''),
      digits: String(first ?? ''),
      decimal: String(first ?? ''),
      date: String(first ?? ''),
      format: rule.params.join(',')
    }
  }
}

/** `validate(data, rules)` — the shortest path to a checked payload. */
export async function validate(
  data: Data,
  rules: Rules,
  options?: ValidatorOptions
): Promise<Data> {
  return new Validator(data, rules, options).validate()
}

export function makeValidator(data: Data, rules: Rules, options?: ValidatorOptions): Validator {
  return new Validator(data, rules, options)
}

export type { PresenceVerifier }
