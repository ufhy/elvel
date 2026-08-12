import type { AuthUser } from '@elysian/auth'
import { AuthorizationResponse, Policy } from '@elysian/auth'
import type { Article } from '../Models/Article.ts'

/**
 * Generated with `bun run playground make:policy Article`, then extended.
 *
 * The method name *is* the ability name: `authorize('update', article)` calls
 * `update()`. Asserted by `scripts/smoke.ts` and exercised over the network.
 */
export class ArticlePolicy extends Policy<Article> {
  /** Reading the list needs no account. */
  static override allowGuests = ['viewAny']

  /**
   * Runs before every ability. Returning a value here settles the check, which
   * is how an administrator override stays in one place instead of being
   * repeated in each method.
   */
  override before(user: AuthUser | null, _ability: string): boolean | undefined {
    if (user?.email === 'admin@example.com') return true

    return undefined
  }

  viewAny(): boolean {
    return true
  }

  view(): boolean {
    return true
  }

  /** An unverified account may read, but not write. */
  create(user: AuthUser): boolean | AuthorizationResponse {
    if (user.emailVerified !== true) {
      return AuthorizationResponse.deny('Verify your e-mail before publishing.')
    }

    return true
  }

  /** Ownership: the response says so, rather than leaving the client guessing. */
  update(user: AuthUser, article: Article): boolean | AuthorizationResponse {
    if (article.author_id === null || article.author_id === undefined) {
      return AuthorizationResponse.deny('This article has no author.')
    }

    if (article.author_id !== user.id) {
      return AuthorizationResponse.deny('You may only edit your own articles.')
    }

    return true
  }

  /** Hide the existence of someone else's article rather than admitting to it. */
  delete(user: AuthUser, article: Article): boolean | AuthorizationResponse {
    if (article.author_id !== user.id) {
      return AuthorizationResponse.denyAsNotFound(`No article [${article.id}].`)
    }

    return true
  }
}
