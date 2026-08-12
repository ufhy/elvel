export type Data = Record<string, unknown>

/** A parsed rule: `min:3` becomes `{ name: 'min', params: ['3'] }`. */
export type ParsedRule = {
  name: string
  params: string[]
  /** Present for object rules such as `Rule.unique(...)`. */
  rule?: DatabaseRule
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

export type RuleDeclaration = string | DatabaseRule | Array<string | DatabaseRule>

export type Rules = Record<string, RuleDeclaration>

export type ValidatorOptions = {
  messages?: Record<string, string>
  attributes?: Record<string, string>
  verifier?: PresenceVerifier
  stopOnFirstFailure?: boolean
}
