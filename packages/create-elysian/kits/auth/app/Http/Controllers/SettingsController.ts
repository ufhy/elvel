import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { Password } from '../../../resources/views/pages/settings/password.tsx'
import { Profile } from '../../../resources/views/pages/settings/profile.tsx'
import { Security } from '../../../resources/views/pages/settings/security.tsx'
import { account, api, messageFrom, sessionRows, withSession } from '../../Support/auth.ts'

/**
 * Everything an account holder changes about themselves.
 *
 * Laravel's starter kit keeps these in a `routes/settings.php` of their own, and
 * the reason is the one visible here: they are the pages a signed-in person
 * comes back to, they all sit behind `auth`, and two of them sit behind the
 * password-confirmation window as well.
 */
export default controller('settings')
  .get(
    '/settings/profile',
    (context) => {
      const person = account(context)
      const { query } = context

      return view(Profile, {
        title: 'Profile',
        name: person.name,
        email: person.email,
        emailVerified: person.emailVerified,
        pending: query.pending === '1',
        saved: query.saved === '1',
        error: errors().first('name') ?? errors().first('email')
      })
    },
    middleware('auth')
  )

  .patch(
    '/settings/profile',
    async (context) => {
      const { body, request } = context
      const person = account(context)

      /**
       * Two endpoints, because better-auth refuses to do it in one.
       *
       * `updateUser` throws `EMAIL_CAN_NOT_BE_UPDATED` the moment an `email`
       * appears in its body — changing an address goes through `changeEmail`,
       * which knows to re-verify. The first version of this sent both to
       * `updateUser` and answered 400 for anybody who edited their address, while
       * carrying a comment claiming better-auth handled it.
       */
      const named = await api().updateUser({
        body: { name: body.name },
        headers: request.headers,
        asResponse: true
      })

      if (!named.ok) {
        return redirect('/settings/profile')
          .withErrors({ name: await messageFrom(named, 'That could not be saved.') })
          .withInput({ name: body.name, email: body.email })
          .toResponse()
      }

      if (body.email !== person.email) {
        const moved = await api().changeEmail({
          body: { newEmail: body.email, callbackURL: '/settings/profile' },
          headers: request.headers,
          asResponse: true
        })

        if (!moved.ok) {
          return redirect('/settings/profile')
            .withErrors({ email: await messageFrom(moved, 'That address could not be used.') })
            .withInput({ name: body.name, email: body.email })
            .toResponse()
        }

        /**
         * Which of the two things just happened depends on the old address.
         *
         * A confirmed one is only replaced once the new one is confirmed as well,
         * and the confirmation goes to the address on file — so the page says a
         * link is on its way. An unconfirmed one is replaced outright, and telling
         * somebody to wait for a link that changes nothing would be a lie the next
         * page load exposes.
         */
        const where = person.emailVerified ? 'pending=1' : 'saved=1'

        return withSession(
          named,
          await redirect(`/settings/profile?${where}`).seeOther().toResponse()
        )
      }

      return withSession(named, await redirect('/settings/profile?saved=1').seeOther().toResponse())
    },
    {
      ...middleware('auth'),
      body: t.Object({ name: t.String(), email: t.String() })
    }
  )

  .delete(
    '/settings/profile',
    async ({ body, request }) => {
      const answer = await api().deleteUser({
        body: { password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/profile')
          .withErrors({ name: await messageFrom(answer, 'That password was wrong.') })
          .toResponse()
      }

      return withSession(answer, await redirect('/').seeOther().toResponse())
    },
    {
      ...middleware('auth'),
      body: t.Object({ password: t.String() })
    }
  )

  // ----------------------------------------------------------------- password

  .get(
    '/settings/password',
    ({ query }) => {
      return view(Password, {
        title: 'Password',
        saved: query.saved === '1',
        error: errors().first('password')
      })
    },
    middleware('auth')
  )

  .put(
    '/settings/password',
    async ({ body, request }) => {
      if (body.password !== body.password_confirmation) {
        return redirect('/settings/password')
          .withErrors({ password: 'The two passwords do not match.' })
          .toResponse()
      }

      const answer = await api().changePassword({
        // Every other session goes: a password change is usually a response to
        // somebody else having had access.
        body: {
          currentPassword: body.current,
          newPassword: body.password,
          revokeOtherSessions: true
        },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/password')
          .withErrors({ password: await messageFrom(answer, 'That current password was wrong.') })
          .toResponse()
      }

      return withSession(
        answer,
        await redirect('/settings/password?saved=1').seeOther().toResponse()
      )
    },
    {
      // Fortify throttles this one at six a minute too: a change form that takes
      // the current password is a place to guess it.
      ...middleware('auth', 'throttle:6,1'),
      body: t.Object({
        current: t.String(),
        password: t.String(),
        password_confirmation: t.String()
      })
    }
  )

  // ----------------------------------------------------------------- security

  .get(
    '/settings/security',
    async ({ request, query }) => {
      const listed = (await api().listSessions({ headers: request.headers })) as unknown

      return view(Security, {
        title: 'Security',
        sessions: sessionRows(listed, request.headers),
        revoked: query.revoked === '1',
        error: errors().first('session')
      })
    },
    // Reading which devices are signed in, and cutting any of them off, is the
    // one place a borrowed unlocked browser does real damage — so it asks.
    middleware('auth', 'password.confirm')
  )

  .post(
    '/settings/security/revoke',
    async ({ body, request }) => {
      await api().revokeSession({
        body: { token: body.id },
        headers: request.headers,
        asResponse: true
      })

      return redirect('/settings/security?revoked=1').seeOther().toResponse()
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ id: t.String() })
    }
  )

  .post(
    '/settings/security/revoke-others',
    async ({ request }) => {
      const answer = await api().revokeOtherSessions({
        headers: request.headers,
        asResponse: true
      })

      return withSession(
        answer,
        await redirect('/settings/security?revoked=1').seeOther().toResponse()
      )
    },
    middleware('auth', 'password.confirm')
  )

// --------------------------------------------------- password confirmation
