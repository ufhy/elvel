import { FormRequest } from '@elvel/http'

/**
 * Generated with `artisan make:request SubscribeRequest`, then extended.
 *
 * Nothing here says anything about redirecting: a browser posting this form is
 * sent back to it with the messages and its input, and an API client asking for
 * JSON gets the 422 — the request decides from `Accept`, so a handler cannot
 * handle one case and forget the other.
 */
export class SubscribeRequest extends FormRequest {
  rules() {
    return {
      email: 'required|email',
      name: 'required|string|min:2',
      password: 'required|string|min:8'
    }
  }

  override messages() {
    return { 'email.email': 'That does not look like an email address.' }
  }
}
