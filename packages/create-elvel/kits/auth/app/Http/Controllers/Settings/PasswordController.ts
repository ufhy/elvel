import { api, messageFrom, withSession } from '@elvel/auth'
import { errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { Password } from '../../../../resources/views/pages/settings/password.tsx'

type Change = { current: string; password: string; password_confirmation: string }

/**
 * Changing the password.
 *
 * The current one is asked for, which is the point: a borrowed unlocked browser
 * should not be able to lock its owner out. better-auth issues a fresh session
 * on success and the new cookie is copied across, or the person is signed out by
 * the very act of changing it.
 */
export default class PasswordController {
  edit({ query }: { query: Record<string, string | undefined> }) {
    return view(Password, {
      title: 'Password',
      saved: query.saved === '1',
      error: errors().first('password')
    })
  }

  async update({ body, request }: { body: Change; request: Request }) {
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

    return withSession(answer, await redirect('/settings/password?saved=1').seeOther().toResponse())
  }
}
