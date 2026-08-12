import type { AuthorizationResponse } from './response.ts'

/** What a policy method may return. `undefined` means "no opinion". */
export type PolicyResult =
  | boolean
  | AuthorizationResponse
  | undefined
  | Promise<boolean | AuthorizationResponse | undefined>

/**
 * A policy groups the abilities for one model.
 *
 * ```ts
 * export class ArticlePolicy extends Policy<Article> {
 *   update(user: AuthUser, article: Article) {
 *     return article.user_id === user.id
 *   }
 * }
 * ```
 *
 * `before()` runs ahead of every method — the usual place for an admin override.
 *
 * Guests: Laravel decides from the reflected type of the `$user` parameter
 * whether an ability may run for a guest. TypeScript erases types, so an
 * ability that should be reachable without a user has to say so by listing its
 * name in the static `allowGuests`.
 */
export abstract class Policy<Model = unknown> {
  /** Abilities that may run for a guest. `true` allows every ability. */
  static allowGuests: string[] | true = []

  /**
   * Runs before every ability. A non-undefined result short-circuits the check;
   * returning `undefined` falls through to the ability itself.
   */
  before?(user: unknown, ability: string, ...args: unknown[]): PolicyResult

  /** Declared so `Model` is used; policies never read it. */
  protected declare readonly model?: Model
}

/** Anything callable as a policy: an instance, or a class to construct. */
export type PolicyLike = Policy | (new () => Policy)

/** Does this policy allow the given ability to run for a guest? */
export function policyAllowsGuests(policy: Policy, ability: string): boolean {
  const allowed = (policy.constructor as typeof Policy).allowGuests

  return allowed === true || (Array.isArray(allowed) && allowed.includes(ability))
}
