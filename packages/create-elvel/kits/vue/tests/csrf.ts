import { test as press, type TestResponse } from '@elvel/testing'
import app from '../bootstrap/app.ts'

/**
 * Post a form the way this kit's client does — with a token fetched, not scraped.
 *
 * The auth kit's version of this file reads `name="_token"` out of the page the
 * form was on. Here there is no such field: these pages are answered with a
 * shell, the same bytes for everybody so that a cache may keep one, and a
 * document carrying a per-session token could not be cached at all.
 *
 * So the token is asked for. `GET /api/session` is unguarded for exactly this
 * reason and answers `{ app, user, csrf }` — and it is a **write**: minting the
 * token makes the session dirty, so that response is the one carrying the cookie
 * the post has to travel with. Sending the token with the page's cookies instead
 * names a session that has no token, which is a 419 that looks like a broken form.
 *
 * `page` is ignored, and the signature keeps it so the five shared test files do
 * not have to know which kit they are running in.
 */
export async function postForm(
  path: string,
  fields: Record<string, string>,
  page: TestResponse,
  carrier: TestResponse = page
): Promise<TestResponse> {
  const { token, from } = await session(carrier)

  /**
   * Both sets of cookies, and in that order.
   *
   * `withCookiesFrom` carries what a response *set*, not what it was sent — and
   * `/api/session` sets only the framework's session cookie. Sending that alone
   * drops better-auth's, so the post arrives as a guest: measured as a
   * `POST /confirm-password` answering `302 /sign-in` while the page before it had
   * answered 200. The session endpoint's copy goes second so its fresher value
   * wins.
   */
  return press(app)
    .withCookiesFrom(carrier)
    .withCookiesFrom(from)
    .form('POST', path, { _token: token, ...fields })
}

async function session(carrier: TestResponse): Promise<{ token: string; from: TestResponse }> {
  const answer = await press(app).withCookiesFrom(carrier).get('/api/session')
  const token = (answer.json() as { csrf?: string }).csrf

  if (!token) throw new Error('No CSRF token from /api/session. Is SESSION_CSRF off?')

  return { token, from: answer }
}
