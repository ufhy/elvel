import { controller } from '@elvel/core'
import { csrfToken, redirect, sessionOf, validateRequest } from '@elvel/http'
import { view } from '@elvel/view'
import { Subscribe } from '../../../resources/views/pages/subscribe.tsx'
import { SubscribeRequest } from '../Requests/SubscribeRequest.ts'

/**
 * Generated with `elvel make:controller SubscribeController`, then extended.
 *
 * The form-and-redirect loop: GET renders, POST validates, and a failure goes back
 * to the GET with the messages and the input flashed for exactly one request.
 */
export default controller('subscribe')
  .get('/subscribe', () => {
    /**
     * `csrfToken()`, not `session.token()`.
     *
     * A session is not given a token until something asks for one, so that a page
     * with no form on it costs no write and no cookie. Reading `token()` here got
     * an empty string and the form posted back a `419`; `csrfToken()` is the call
     * that says "this page is handing one out".
     */
    return view(Subscribe, { title: 'Subscribe', token: csrfToken() })
  })

  .post('/subscribe', async (context) => {
    // Throws a redirect for a browser, a 422 for an API client. Either way this
    // line is the only place validation is mentioned.
    const data = await validateRequest(SubscribeRequest, {
      body: context.body,
      // The request decides browser-or-client; passing it through is all a handler
      // has to do.
      request: context.request
    })

    sessionOf(context).flash('status', `Subscribed ${String(data.email)}.`)

    return redirect('/subscribe/done').seeOther().toResponse()
  })

  .get('/subscribe/done', (context) => ({
    status: sessionOf(context).get('status') ?? null
  }))
