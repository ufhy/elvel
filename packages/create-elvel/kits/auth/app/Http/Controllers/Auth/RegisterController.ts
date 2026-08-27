import { api, problemFrom, withSession } from '@elvel/auth'
import { config } from '@elvel/core'
import { currentScope, errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { SignUp } from '../../../../resources/views/pages/auth/sign-up.tsx'

type Details = { name: string; email: string; password: string }

/**
 * Creating an account.
 *
 * Registering signs the person in, which is what better-auth does and what
 * anybody filling in the form expects. A refusal — a taken address, a password
 * the policy rejects — comes back to the form with its message through the
 * session, the same way a validation failure does anywhere else.
 */
export default class RegisterController {
  create() {
    return view(SignUp, { title: 'Create an account', error: errors().first() })
  }

  async store({ body, request }: { body: Details; request: Request }) {
    const answer = await api().signUpEmail({
      body: { name: body.name, email: body.email, password: body.password },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      const problem = await problemFrom(answer, 'That account could not be created.')

      /**
       * Under the field it is about.
       *
       * Everything better-auth refuses here used to land on `email`, so "Password
       * too short" appeared beneath the address somebody had typed correctly. The
       * code is what tells them apart — the message alone cannot, and matching on
       * its wording would break the first time that wording changed.
       */
      const field = problem.code.startsWith('PASSWORD_') ? 'password' : 'email'

      return redirect(config('auth.signUpRoute', '/sign-up'))
        .withErrors({ [field]: problem.message })
        .withInput({ name: body.name, email: body.email })
        .toResponse()
    }

    /**
     * A new session id, now that this browser is somebody.
     *
     * Session fixation: an id chosen before signing in is an id somebody else
     * may have chosen, and if it still names the session afterwards then
     * whoever chose it is signed in as this user. The CSRF token rotates with
     * it, so a token picked up while signed out no longer authorises writes
     * while signed in.
     *
     * Every path that turns an anonymous browser into a signed-in one needs
     * this, not just the password one — and the account with two factors is the
     * one most worth protecting.
     */
    await currentScope()?.session.regenerate()

    // Signing up signs you in, so the cookie travels the same way.
    return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
  }
}
