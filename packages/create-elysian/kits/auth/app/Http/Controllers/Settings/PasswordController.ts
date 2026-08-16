import { messageFrom, withSession } from '@elysian/auth'
import { controller } from '@elysian/core'
import { errors, middleware, redirect } from '@elysian/http'
import { view } from '@elysian/view'
import { t } from 'elysia'
import { Password } from '../../../../resources/views/pages/settings/password.tsx'
import { api } from '../../../Support/auth.ts'

/**
 * Changing the password.
 *
 * The current one is asked for, which is the point: a borrowed unlocked browser
 * should not be able to lock its owner out. better-auth issues a fresh session
 * on success and the new cookie is copied across, or the person is signed out by
 * the very act of changing it.
 */
export default controller('settings-password')
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
