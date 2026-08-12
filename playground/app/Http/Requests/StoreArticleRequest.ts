import { FormRequest } from '@elysian/http'

/**
 * The full form-request lifecycle, asserted by `scripts/smoke.ts`.
 *
 * Order: prepareForValidation → authorize → rules → passedValidation. A refused
 * authorization is a 403 and must not reveal which fields would have failed.
 */
export class StoreArticleRequest extends FormRequest {
  static override failOnUnknownFields = false

  override authorize(): boolean {
    // A real app would consult a policy; the header keeps it inspectable.
    return this.input('forbidden') !== 'yes'
  }

  override prepareForValidation(): void {
    this.merge({ title: String(this.input('title', '')).trim() })
  }

  rules() {
    return {
      title: 'required|string|min:3',
      body: 'required|string|min:10',
      status: 'required|in:draft,published',
      published_at: 'required_if:status,published'
    }
  }

  override messages() {
    return { 'title.required': 'An article needs a title.' }
  }
}
