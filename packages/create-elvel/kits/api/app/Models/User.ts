import { Model } from '@elvel/database'

/**
 * The account better-auth keeps, as a model you can query.
 *
 * better-auth owns this table: it writes the rows, and `artisan auth:schema`
 * generates the migration from `config/auth.ts`, so the columns are whatever
 * that file's options and plugins make them. This model is the *reading* side —
 * a relation to point at, a place for scopes, and the way to load a user in a
 * command or a job where there is no request and therefore no `auth()`.
 *
 * Creating accounts is better-auth's job, not this model's. `User.create(...)`
 * would write a row with no `account` beside it — no password, no provider —
 * and the person could never sign in. Register through the auth endpoints, and
 * use `UserFactory` in tests, which exists for the rows a test needs to *find*.
 */
export class User extends Model {
  /** Singular, and not `users`: better-auth's own naming. */
  static override table = 'user'

  /** The key is a generated string, not an auto-increment. */
  static override incrementing = false

  static override keyType = 'string' as const

  /**
   * camelCase, because better-auth writes these columns and it does not use
   * the framework's convention. Naming them here is what keeps `save()` and
   * `touch()` writing the columns that exist.
   */
  static override CREATED_AT = 'createdAt'
  static override UPDATED_AT = 'updatedAt'

  static override casts = { emailVerified: 'boolean' } as never

  /** Never rendered by accident, and never in a JSON response. */
  static override hidden = ['image']

  declare id: string
  declare name: string
  declare email: string
  declare emailVerified: boolean
  declare image: string | null
  declare createdAt: Date
  declare updatedAt: Date

  /** Accounts that have confirmed their address — `User.query().verified()`. */
  static scopeVerified(query: { where(column: string, value: unknown): unknown }) {
    query.where('emailVerified', true)
  }
}
