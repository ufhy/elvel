import { api, messageFrom, withSession } from '@elyvel/auth'
import { controller } from '@elyvel/core'
import { errors, middleware, redirect } from '@elyvel/http'
import { view } from '@elyvel/view'
import { t } from 'elysia'
import { SignUp } from '../../../../resources/views/pages/auth/sign-up.tsx'

/**
 * Creating an account.
 *
 * Registering signs the person in, which is what better-auth does and what
 * anybody filling in the form expects. A refusal — a taken address, a password
 * the policy rejects — comes back to the form with its message through the
 * session, the same way a validation failure does anywhere else.
 */
export default controller('auth-register')
  .get(
    '/sign-up',
    () => view(SignUp, { title: 'Create an account', error: errors().first('email') }),
    middleware('guest')
  )

  .post(
    '/sign-up',
    async ({ body, request }) => {
      const answer = await api().signUpEmail({
        body: { name: body.name, email: body.email, password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/sign-up')
          .withErrors({ email: await messageFrom(answer, 'That account could not be created.') })
          .withInput({ name: body.name, email: body.email })
          .toResponse()
      }

      // Signing up signs you in, so the cookie travels the same way.
      return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
    },
    {
      ...middleware('guest', 'throttle:6,1'),
      body: t.Object({ name: t.String(), email: t.String(), password: t.String() })
    }
  )

// ------------------------------------------------------ forgotten password
