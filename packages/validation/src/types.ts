export type Data = Record<string, unknown>

/** A parsed rule: `min:3` becomes `{ name: 'min', params: ['3'] }`. */
export type ParsedRule = {
  name: string
  params: string[]
  /** Present for object rules such as `Rule.unique(...)`. */
  rule?: DatabaseRule
  /** Present for a rule written as a function. */
  closure?: ClosureRule
}

export type RuleContext = {
  attribute: string
  value: unknown
  params: string[]
  data: Data
  /** The rule object, when the rule came from `Rule.unique()` or similar. */
  rule?: DatabaseRule
  /** Every rule declared for this attribute, so a rule can inspect its siblings. */
  siblings: ParsedRule[]
  /**
   * The rule key this attribute came from — `items.*.price` for `items.0.price`,
   * and the attribute itself when no wildcard was involved.
   */
  pattern: string
  verifier?: PresenceVerifier
}

export type RuleResult = boolean | Promise<boolean>

export type RuleHandler = (context: RuleContext) => RuleResult

/**
 * Reads the database for `unique` and `exists`.
 *
 * Kept as an interface so `@elysian/validation` does not depend on the database
 * package: the provider wires a query-builder-backed implementation when one is
 * available, and the rules fail loudly when it is not.
 */
export interface PresenceVerifier {
  /** Rows matching `column = value`, minus an ignored id. */
  count(
    table: string,
    column: string,
    value: unknown,
    ignore?: { id: unknown; column: string },
    extra?: Array<[string, unknown]>
  ): Promise<number>

  /** Rows whose `column` is one of `values`. */
  countIn(
    table: string,
    column: string,
    values: unknown[],
    extra?: Array<[string, unknown]>
  ): Promise<number>
}

/** Base for the object-form rules that need a query. */
export abstract class DatabaseRule {
  protected wheres: Array<[string, unknown]> = []

  constructor(
    readonly table: string,
    readonly column?: string
  ) {}

  abstract readonly name: string

  /** Extra constraint, as Laravel's `->where('account_id', 1)`. */
  where(column: string, value: unknown): this {
    this.wheres.push([column, value])
    return this
  }

  whereNot(column: string, value: unknown): this {
    // Encoded as `!value`, the same shorthand Laravel's string rules accept.
    this.wheres.push([column, `!${String(value)}`])
    return this
  }

  constraints(): Array<[string, unknown]> {
    return [...this.wheres]
  }

  /** Rendered form, so a rule object can travel through the string parser. */
  toString(): string {
    return `${this.name}:${this.table}${this.column ? `,${this.column}` : ''}`
  }
}

export class UniqueRule extends DatabaseRule {
  readonly name = 'unique'

  private ignored?: { id: unknown; column: string }

  /** Skip a row, so updating a record does not collide with itself. */
  ignore(id: unknown, column = 'id'): this {
    this.ignored = { id, column }
    return this
  }

  ignoring(): { id: unknown; column: string } | undefined {
    return this.ignored
  }
}

export class ExistsRule extends DatabaseRule {
  readonly name = 'exists'
}

/** `Rule.unique('users', 'email').ignore(user.id)` */
export const Rule = {
  unique(table: string, column?: string): UniqueRule {
    return new UniqueRule(table, column)
  },

  exists(table: string, column?: string): ExistsRule {
    return new ExistsRule(table, column)
  },

  /**
   * Apply rules only when a condition holds — `Rule.when()`.
   *
   * The condition is a function of the data and is asked at validation time, not
   * when the rules are declared: `required_if` covers the common case, and this
   * is for the ones a string cannot express.
   */
  when(
    condition: boolean | ((data: Data) => boolean),
    rules: RuleDeclaration,
    otherwise: RuleDeclaration = []
  ): ConditionalRules {
    return new ConditionalRules(
      typeof condition === 'function' ? condition : () => condition,
      rules,
      otherwise
    )
  },

  /** The mirror of `when`. */
  unless(
    condition: boolean | ((data: Data) => boolean),
    rules: RuleDeclaration,
    otherwise: RuleDeclaration = []
  ): ConditionalRules {
    const test = typeof condition === 'function' ? condition : () => condition

    return new ConditionalRules((data) => !test(data), rules, otherwise)
  },

  /**
   * Rules decided per element — `Rule.forEach()`.
   *
   * The callback sees the element and its attribute, so a list whose items are
   * validated differently depending on their own contents finally has a way to
   * say so.
   */
  forEach(
    callback: (value: unknown, attribute: string, data: Data) => RuleDeclaration
  ): NestedRules {
    return new NestedRules(callback)
  },

  in(values: Array<string | number>): string {
    return `in:${values.join(',')}`
  },

  notIn(values: Array<string | number>): string {
    return `not_in:${values.join(',')}`
  },

  requiredIf(field: string, value: string | number): string {
    return `required_if:${field},${value}`
  }
}

/**
 * A rule written as a function — Laravel's closure rule.
 *
 * Return `true` (or nothing) to pass, or a **message** to fail with. Laravel
 * calls a `$fail` callback; returning the message is the same information with
 * one less moving part, and it makes the rule usable in a `.map()`.
 *
 * ```ts
 * validator(data, {
 *   slug: ['required', ({ value }) => (banned.has(value) ? 'That slug is taken.' : true)]
 * })
 * ```
 */
export type ClosureRule = (
  context: RuleContext
) => string | true | void | Promise<string | true | void>

/** `Rule.when(...)` — rules chosen from the data, at validation time. */
export class ConditionalRules {
  constructor(
    readonly condition: (data: Data) => boolean,
    readonly rules: RuleDeclaration,
    readonly otherwise: RuleDeclaration = []
  ) {}

  resolve(data: Data): RuleDeclaration {
    return this.condition(data) ? this.rules : this.otherwise
  }
}

/** `Rule.forEach(...)` — rules decided per element of a wildcard. */
export class NestedRules {
  constructor(
    readonly callback: (value: unknown, attribute: string, data: Data) => RuleDeclaration
  ) {}
}

export type RuleDeclaration =
  | string
  | DatabaseRule
  | ClosureRule
  | ConditionalRules
  | NestedRules
  | Array<string | DatabaseRule | ClosureRule | ConditionalRules | NestedRules>

export type Rules = Record<string, RuleDeclaration>

export type ValidatorOptions = {
  messages?: Record<string, string>
  attributes?: Record<string, string>
  verifier?: PresenceVerifier
  stopOnFirstFailure?: boolean
}
