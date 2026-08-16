import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { Profile } from '../../../../resources/views/pages/settings/profile.tsx'
import { account, api, messageFrom, withSession } from '../../../Support/auth.ts'

/**
 * The name and address on the account, and closing it.
 *
 * Laravel's starter kit keeps profile and security in a `Settings` directory of
 * their own with a `routes/settings.php` beside them; this is that split, minus
 * the separate route file, which this framework has no way to mount yet.
 *
 * Deleting lives here rather than with security because it is the last thing on
 * the profile page — and it asks for the password, which is what makes it safe
 * to leave on a page somebody reaches with an unlocked browser.
 */
export default controller('settings-profile')
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
