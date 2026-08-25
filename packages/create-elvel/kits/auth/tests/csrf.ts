import { test as press, type TestResponse } from '@elvel/testing'
import app from '../bootstrap/app.ts'

/**
 * Post a form the way a browser would — with the token, and with the cookies.
 *
 * Every write in this application needs both, and getting either wrong is a 419
 * rather than a failure of whatever was being tested. One helper, so the tests
 * read as what they are about.
 *
 * Two arguments for the two, because they are not always the same response.
 * `page` is where the form was — in this kit, where the token is. `carrier` is
 * whose session to continue, which is often an earlier response: the enrolment
 * tests fetch a settings page while signed in, and the cookies that matter are
 * the sign-in's, not that page's.
 *
 * **This file is the seam between the kits.** The Vue kit answers those pages with
 * a cacheable shell, which by definition carries no token — so it ships its own
 * version that asks `GET /api/session` instead. Nothing else about the five test
 * files differs, which is why the seam is here and not in them.
 */
export async function postForm(
  path: string,
  fields: Record<string, string>,
  page: TestResponse,
  carrier: TestResponse = page
): Promise<TestResponse> {
  return press(app)
    .withCookiesFrom(carrier)
    .form('POST', path, { _token: tokenIn(page.body), ...fields })
}

/** The hidden CSRF field, as the form renders it. */
function tokenIn(html: string): string {
  const found = /name="_token" value="([^"]+)"/.exec(html)?.[1]

  if (!found) throw new Error('No CSRF token on the page. Is SESSION_CSRF off?')

  return found
}
