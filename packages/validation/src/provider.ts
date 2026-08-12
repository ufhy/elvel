import { app, ServiceProvider } from '@elysian/core'
import type { Data, PresenceVerifier, Rules, ValidatorOptions } from './types.ts'
import { Validator } from './validator.ts'

/** The minimum this package needs from a query builder, structurally. */
type Query = {
  where(column: string, operator: string, value: unknown): Query
  whereIn(column: string, values: unknown[]): Query
  count(): Promise<number>
}

type Manager = { table(name: string): Promise<Query> }

/**
 * Reads the database for `unique` and `exists`.
 *
 * Duck-typed rather than imported, so `@elysian/validation` carries no
 * dependency on `@elysian/database`: the rules work without a database, and only
 * these two need one.
 */
export class DatabasePresenceVerifier implements PresenceVerifier {
  constructor(private readonly manager: Manager) {}

  async count(
    table: string,
    column: string,
    value: unknown,
    ignore?: { id: unknown; column: string },
    extra: Array<[string, unknown]> = []
  ): Promise<number> {
    let query = (await this.manager.table(table)).where(column, '=', value)

    // `->ignore(id)` is what lets an update not collide with its own row.
    if (ignore) query = query.where(ignore.column, '!=', ignore.id)

    return this.applyExtra(query, extra).count()
  }

  async countIn(
    table: string,
    column: string,
    values: unknown[],
    extra: Array<[string, unknown]> = []
  ): Promise<number> {
    const query = (await this.manager.table(table)).whereIn(column, values)

    return this.applyExtra(query, extra).count()
  }

  private applyExtra(query: Query, extra: Array<[string, unknown]>): Query {
    let current = query

    for (const [column, value] of extra) {
      const text = String(value)

      // `!value` negates, and `NULL` compares against null, as Laravel's
      // string-rule shorthand does.
      if (text.startsWith('!')) current = current.where(column, '!=', text.slice(1))
      else if (text === 'NULL') current = current.where(column, 'is', null)
      else current = current.where(column, '=', value)
    }

    return current
  }
}

declare module '@elysian/contracts' {
  interface ContainerBindings {
    'validation.verifier': PresenceVerifier | undefined
  }
}

export class ValidationServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('validation.verifier', (app) => {
      // Optional: validation must work in an app with no database at all.
      if (!app.bound('db')) return undefined

      return new DatabasePresenceVerifier(app.make('db' as never) as Manager)
    })
  }
}

/**
 * Build a validator wired to the application's database.
 *
 * ```ts
 * const data = await validator(body, { email: 'required|email|unique:users' }).validate()
 * ```
 */
export function validator(data: Data, rules: Rules, options: ValidatorOptions = {}): Validator {
  return new Validator(data, rules, {
    // The caller can still pass its own verifier, or none at all.
    verifier: app('validation.verifier'),
    ...options
  })
}
