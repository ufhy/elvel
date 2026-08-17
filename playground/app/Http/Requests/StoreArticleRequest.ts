import { FormRequest } from '@elvel/http'
import { Rule } from '@elvel/validation'

/**
 * Generated with `bun run playground make:request StoreArticle`, then extended.
 *
 * The full lifecycle is asserted by `scripts/smoke.ts`: prepareForValidation →
 * authorize → rules → passedValidation. A refused authorization is a 403 and
 * must not reveal which fields would have failed.
 */
export class StoreArticleRequest extends FormRequest {
  /** Return false to refuse the request with a 403, not a 422. */
  override authorize(): boolean {
    // A real app would consult a policy; the field keeps it inspectable.
    return this.input('forbidden') !== 'yes'
  }

  override prepareForValidation(): void {
    this.merge({ title: String(this.input('title', '')).trim() })
  }

  rules() {
    return {
      title: 'required|string|min:3',
      // The object form hits the database through the presence verifier. Only
      // validated fields reach `validated()`, so a column the model must fill
      // has to be declared here — as in Laravel.
      slug: ['required', 'string', Rule.unique('articles', 'slug')],
      body: 'required|string|min:10',
      status: 'required|in:draft,published',
      published_at: 'required_if:status,published'
    }
  }

  /** Custom messages, keyed by `rule` or `field.rule`. */
  override messages() {
    return { 'title.required': 'An article needs a title.' }
  }
}
