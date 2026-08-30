import { Arr } from '@elvel/support'
import { ErrorBag } from './error-bag.ts'
import { FileRule } from './files.ts'
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
  type ClosureRule,
  ConditionalRules,
  type Data,
  DatabaseRule,
  NestedRules,
  type ParsedRule,
  type PresenceVerifier,
  type RuleContext,
  type RuleDeclaration,
  type Rules,
  type ValidatorOptions
} from './types.ts'
import { expandWildcard, explicitKeys } from './wildcards.ts'

export class ValidationError extends Error {
  /** Read by the framework's exception handler, as HttpException's is. */
  readonly status = 422

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
/**
 * The rules that can wait on something, read off their own declarations at load.
 *
 * A hand-kept list would be a thing to forget: add a rule that reaches the network
 * and the list is silently wrong, while `async` on the handler cannot be. Once at
 * module scope, because asking every handler its constructor name on every
 * validation cost more than the concurrency it was deciding about.
 */
const BLOCKING_RULES = new Set(
  Object.entries(RULES)
    .filter(([, handler]) => handler.constructor.name === 'AsyncFunction')
    .map(([name]) => name)
)

export class Validator {
  private readonly rules: Record<string, ParsedRule[]> = {}

  /**
   * Whether any rule here could wait on something, decided once as they are parsed.
   *
   * It settles whether the attributes are worth running together. A closure counts
   * — the application wrote it and it may do anything — and so does any handler
   * declared `async`.
   */
  private canBlock = false
  private readonly afterCallbacks: Array<(validator: Validator) => void | Promise<void>> = []
  private readonly excluded = new Set<string>()
  readonly errors = new ErrorBag()

  /**
   * Which wildcard rule each expanded attribute came from —
   * Laravel's `implicitAttributes`.
   *
   * Kept because the pattern is what the *developer* wrote: a message or a label
   * configured for `items.*.price` has to be found from `items.0.price`, and
   * `distinct` has to know which attributes are its siblings.
   */
  private readonly patterns = new Map<string, string>()

  private ran = false

  constructor(
    private readonly data: Data,
    rules: Rules,
    private readonly options: ValidatorOptions = {}
  ) {
    for (const [attribute, declaration] of Object.entries(rules)) {
      // `Rule.when()` is answered here, against the data as given: the rules a
      // conditional produces then behave exactly like written ones, wildcards
      // and all.
      const resolved =
        declaration instanceof ConditionalRules ? declaration.resolve(this.data) : declaration

      if (!attribute.includes('*')) {
        const parsed = Validator.parse(resolved)

        this.noteBlocking(parsed)
        this.rules[attribute] = parsed

        continue
      }

      // One rule per element, in place of the pattern. An `items.*.price` with no
      // matching data contributes nothing — the rule on `items` reports that.
      for (const expanded of expandWildcard(this.data, attribute)) {
        this.patterns.set(expanded, attribute)

        /**
         * `Rule.forEach()` is asked once per element, which is the whole point:
         * the callback sees the element it is deciding rules for. Anything else
         * is parsed once and shared.
         */
        const parsed = Validator.parse(
          resolved instanceof NestedRules
            ? resolved.callback(Arr.get(this.data, expanded), expanded, this.data)
            : resolved
        )

        this.noteBlocking(parsed)
        this.rules[expanded] = [...(this.rules[expanded] ?? []), ...parsed]
      }
    }
  }

  /** The rule key an attribute came from: the pattern, or the attribute itself. */
  private patternFor(attribute: string): string {
    return this.patterns.get(attribute) ?? attribute
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

      // A function is a rule in its own right; it carries its own message, so
      // there is nothing to look up in the catalogue.
      // A builder is its own string: `File.image().max('2mb')` is exactly what
      // you would have written by hand, and says so through `toString()`.
      if (entry instanceof FileRule) return Validator.parse(entry.toString())

      if (typeof entry === 'function') {
        return [{ name: 'closure', params: [], closure: entry as ClosureRule }]
      }

      if (entry instanceof ConditionalRules) return Validator.parse(entry.resolve({}))

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

    const attributes = Object.entries(this.rules)

    if (this.options.stopOnFirstFailure || !this.canBlock) {
      /**
       * Sequential, for one of two reasons.
       *
       * `stopOnFirstFailure` is a statement about order — it means the first
       * attribute that fails, and running them together would make it whichever
       * attribute's slowest rule came back first.
       *
       * Or there is nothing to overlap: every rule here answers without waiting on
       * anything, so a task and a promise per attribute would be pure overhead on a
       * form that finishes in under three microseconds.
       */
      for (const [attribute, rules] of attributes) {
        if (this.options.stopOnFirstFailure && this.errors.isNotEmpty()) break
        if (this.excluded.has(attribute)) continue

        // The chain is written out rather than calling `runAttribute`, which costs
        // an async frame per attribute. This branch exists for the forms where that
        // is the whole budget.
        for (const rule of rules) {
          const passed = await this.runRule(attribute, rule, rules, this.errors)

          if (this.excluded.has(attribute)) break
          if (passed) continue
          if (this.shouldStopValidating(attribute, rules, this.errors)) break
        }
      }
    } else {
      /**
       * One task per attribute, run together.
       *
       * A form with `unique:` on three fields made three database round trips one
       * after another, and `active_url` can hold a DNS lookup for three seconds
       * while every attribute after it waits its turn. Attributes are independent:
       * `bail` and implicit failures stop *an attribute*, and the `exclude*` family
       * only ever excludes the attribute it is written on.
       *
       * Each fills its own bag. `ErrorBag` is a map and its key order is the order
       * a form reports its fields in, so the bags are merged below in the order the
       * rules were declared rather than the order the network answered.
       */
      const bags = await Promise.all(
        attributes.map(async ([attribute, rules]) => {
          if (this.excluded.has(attribute)) return undefined

          const bag = new ErrorBag()

          await this.runAttribute(attribute, rules, bag)

          return bag
        })
      )

      for (const bag of bags) {
        if (bag !== undefined) this.errors.merge(bag)
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

  /** Remember whether this set brought anything that waits. */
  private noteBlocking(rules: ParsedRule[]): void {
    if (this.canBlock) return

    for (const rule of rules) {
      if (rule.closure !== undefined || BLOCKING_RULES.has(rule.name)) {
        this.canBlock = true

        return
      }
    }
  }

  /** One attribute's rules, in order, until one of them says to stop. */
  private async runAttribute(attribute: string, rules: ParsedRule[], bag: ErrorBag): Promise<void> {
    for (const rule of rules) {
      const passed = await this.runRule(attribute, rule, rules, bag)

      // An excluded attribute is not validated at all: its remaining rules
      // describe a value that will never reach `validated()`.
      if (this.excluded.has(attribute)) return

      if (passed) continue

      // Stop this attribute when `bail` is set, or when an implicit rule
      // failed: reporting "min" on an absent value is noise.
      if (this.shouldStopValidating(attribute, rules, bag)) return
    }
  }

  /**
   * Run one rule, returning whether validation should continue for this
   * attribute. Records a failure when the rule does not pass.
   */
  private async runRule(
    attribute: string,
    rule: ParsedRule,
    siblings: ParsedRule[],
    bag: ErrorBag
  ): Promise<boolean> {
    if (NON_VALIDATING_RULES.has(rule.name) && !EXCLUDE_RULES.has(rule.name)) return true

    const value = Arr.get(this.data, attribute)

    if (EXCLUDE_RULES.has(rule.name)) {
      if (await this.shouldExclude(attribute, rule, siblings)) this.excluded.add(attribute)
      return true
    }

    if (!this.isValidatable(attribute, rule, value, siblings)) return true

    if (rule.closure) {
      const outcome = await rule.closure({
        attribute,
        value,
        params: [],
        data: this.data,
        siblings,
        pattern: this.patternFor(attribute),
        verifier: this.options.verifier
      })

      if (typeof outcome === 'string') {
        // The closure's own message, used verbatim: it was written for this
        // failure, and a catalogue entry could only be vaguer.
        bag.add(attribute, outcome)

        return false
      }

      return true
    }

    const handler = RULES[rule.name]

    if (!handler) {
      throw new Error(`Validation rule [${rule.name}] does not exist.`)
    }

    /**
     * `required_if:items.*.kind,gift` has to mean *this* element's sibling.
     *
     * Each `*` in a dependent rule's parameters is filled with the key of the
     * element being validated, in order — so while `items.2.to` is checked, the
     * rule reads `items.2.kind`. Left as written it points at a field called
     * literally `items.*.kind`, which never exists, so the rule silently never
     * fires: the failure mode is a required field that is never required.
     */
    const params = DEPENDENT_RULES.has(rule.name)
      ? fillWildcards(rule.params, explicitKeys(this.patternFor(attribute), attribute))
      : rule.params

    const context: RuleContext = {
      attribute,
      value,
      params,
      data: this.data,
      rule: rule.rule,
      siblings,
      // `distinct` needs it: its question is about the other elements, and only
      // the pattern knows which attributes those are.
      pattern: this.patternFor(attribute),
      verifier: this.options.verifier
    }

    if (await handler(context)) return true

    this.addFailure(attribute, rule, value, siblings, bag)

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

  private shouldStopValidating(attribute: string, siblings: ParsedRule[], bag: ErrorBag): boolean {
    if (this.hasRule(siblings, 'bail')) return bag.has(attribute)

    // An implicit failure means the value was absent; later rules would only
    // restate that.
    return bag.failedImplicit(attribute)
  }

  private hasRule(rules: ParsedRule[], name: string): boolean {
    return rules.some((rule) => rule.name === name)
  }

  private addFailure(
    attribute: string,
    rule: ParsedRule,
    value: unknown,
    siblings: ParsedRule[],
    bag: ErrorBag
  ): void {
    const numeric = siblings.some((sibling) =>
      ['numeric', 'integer', 'decimal'].includes(sibling.name)
    )

    const type = SIZE_RULES.has(rule.name) ? typeOf(value, numeric) : 'string'
    const template = resolveMessage(rule.name, type, this.customMessagesFor(attribute))

    bag.add(
      attribute,
      interpolate(template, this.replacements(attribute, rule)),
      IMPLICIT_RULES.has(rule.name)
    )
  }

  /**
   * `attribute.rule` beats `rule`, matching Laravel's message lookup order.
   *
   * An expanded attribute also answers to its pattern, so a message written for
   * `items.*.price` is found from `items.0.price` — the concrete key is ours, not
   * something the developer ever wrote down.
   *
   * The split is from the right: a key is `<attribute>.<rule>`, and an attribute
   * may itself contain dots.
   */
  private customMessagesFor(attribute: string): Record<string, string> {
    const messages = this.options.messages ?? {}
    const scoped: Record<string, string> = {}
    const pattern = this.patternFor(attribute)

    for (const [key, message] of Object.entries(messages)) {
      const separator = key.lastIndexOf('.')

      if (separator === -1) {
        scoped[key] = message
        continue
      }

      const target = key.slice(0, separator)
      const rule = key.slice(separator + 1)

      if (target === attribute || target === pattern) scoped[rule] = message
    }

    return scoped
  }

  private replacements(attribute: string, rule: ParsedRule): Record<string, string> {
    const pattern = this.patternFor(attribute)
    const label =
      this.options.attributes?.[attribute] ??
      this.options.attributes?.[pattern] ??
      humanizeAttribute(attribute)

    // `:index` is the first `*` as it stands in the data; `:position` counts from
    // one, because "the 1st line" is what a person reading the error is looking at.
    const [index] = explicitKeys(pattern, attribute)
    const numericIndex = Number(index)
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
      index: index ?? '',
      position: Number.isNaN(numericIndex) ? (index ?? '') : String(numericIndex + 1),
      min: String(first ?? ''),
      // `between:1,5` puts the ceiling second; `max:5` puts it first. Reading only
      // the second parameter rendered "must not be greater than  characters" for
      // every `max` rule, which shipped until a file test asked for the number.
      max: String(second ?? first ?? ''),
      size: String(first ?? ''),
      digits: String(first ?? ''),
      decimal: String(first ?? ''),
      date: String(first ?? ''),
      format: rule.params.join(','),
      encoding: String(first ?? '')
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

/** Replace each `*` with the next explicit key, left to right. */
function fillWildcards(params: string[], keys: string[]): string[] {
  if (keys.length === 0) return params

  return params.map((param) => {
    let index = 0

    return param.replace(/\*/g, () => keys[index++] ?? '*')
  })
}
