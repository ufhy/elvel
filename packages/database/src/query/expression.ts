/**
 * A raw SQL fragment that must not be quoted or parameterised.
 *
 * Laravel's `DB::raw()`. Kept as a class so the grammar can tell "this is SQL"
 * from "this is a value" without a magic string convention.
 */
export class Expression {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value
  }
}

export function raw(value: string): Expression {
  return new Expression(value)
}

export function isExpression(value: unknown): value is Expression {
  return value instanceof Expression
}
