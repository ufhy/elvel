import { api, messageFrom, user, withSession } from '@elvel/auth'
import { controller } from '@elvel/core'
import { currentScope, errors, middleware, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { t } from 'elysia'
import { TwoFactor } from '../../../../resources/views/pages/settings/two-factor.tsx'

/**
 * Turning two-factor authentication on and off.
 *
 * Behind `password.confirm` as well as `auth`, for the same reason the sessions
 * page is: a borrowed unlocked browser must not be able to add a factor its owner
 * does not hold, nor remove the one they do. better-auth asks for the password
 * again on every one of these endpoints anyway; this stops the *page* being
 * reachable without it.
 *
 * Enrolment is two steps, because better-auth makes it two steps and it is right
 * to. `enableTwoFactor` hands back a secret and recovery codes but leaves the
 * account alone; only a correct code from the authenticator turns it on. Without
 * that confirmation a mistyped setup would lock somebody out of their own
 * account — which is the one failure this feature must not have.
 */
export default controller('settings-two-factor')
  .get(
    '/settings/two-factor',
    () => {
      const session = currentScope()?.session

      /**
       * The enrolment in progress, flashed by the step before.
       *
       * It is in the session for exactly one request. That is a real if small
       * exposure — the secret touches the session store — and it is the trade
       * Laravel's own Fortify makes for the same reason: the alternative is
       * rendering it from the POST, where a refresh re-posts and silently rotates
       * the secret somebody has just scanned.
       */
      const pending = session?.get('two-factor.pending') as
        | { uri: string; secret: string; codes: string[] }
        | undefined

      return view(TwoFactor, {
        title: 'Two-factor',
        enabled: user()?.twoFactorEnabled === true,
        pending,
        error: errors().first('two-factor')
      })
    },
    middleware('auth', 'password.confirm')
  )

  /**
   * Step one: get a secret, and show it.
   *
   * Nothing about the account changes here. What comes back is a TOTP URI, the
   * secret inside it for anybody typing it in by hand, and ten recovery codes —
   * which are shown once, here, and never again.
   */
  .post(
    '/settings/two-factor',
    async ({ body, request }) => {
      const answer = await api().enableTwoFactor({
        body: { password: body.password },
        /**
         * The headers, without which this is a 401.
         *
         * better-auth's server API takes the session from what it is handed, not
         * from any ambient context — every endpoint in this kit passes them for
         * that reason. Omitted here it answered `Unauthorized` while the page
         * still rendered its "set it up" form, so the only symptom was a
         * password that never seemed to be right.
         */
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/two-factor')
          .withErrors({ 'two-factor': await messageFrom(answer, 'That password did not match.') })
          .toResponse()
      }

      const enrolment = (await answer.json()) as { totpURI?: string; backupCodes?: string[] }

      if (typeof enrolment.totpURI !== 'string') {
        /**
         * 1.7 made this response a discriminated union.
         *
         * `enableTwoFactor` answers `{ method: 'otp' }` when the account is
         * enrolling by e-mailed code instead, and there is no URI to show. This
         * kit only ships the authenticator flow, so it says so rather than
         * rendering a QR code for `undefined`.
         */
        return redirect('/settings/two-factor')
          .withErrors({ 'two-factor': 'This application only supports authenticator apps.' })
          .toResponse()
      }

      return withSession(
        answer,
        await redirect('/settings/two-factor')
          .with('two-factor.pending', {
            uri: enrolment.totpURI,
            secret: secretFrom(enrolment.totpURI),
            codes: enrolment.backupCodes ?? []
          })
          .seeOther()
          .toResponse()
      )
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ password: t.String() })
    }
  )

  /**
   * Step two: the first code, which is what actually turns it on.
   *
   * The same endpoint a sign-in challenge uses. Called with a session already in
   * hand it confirms the enrolment instead of completing a sign-in.
   */
  .post(
    '/settings/two-factor/confirm',
    async ({ body, request }) => {
      const answer = await api().verifyTOTP({
        body: { code: body.code },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return (
          redirect('/settings/two-factor')
            .withErrors({ 'two-factor': await messageFrom(answer, 'That code did not work.') })
            // Kept for another request, so a mistyped code does not throw away the
            // QR code and the recovery codes along with it.
            .with('two-factor.pending', currentScope()?.session.get('two-factor.pending'))
            .toResponse()
        )
      }

      return withSession(
        answer,
        await redirect('/settings/two-factor?on=1').seeOther().toResponse()
      )
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ code: t.String() })
    }
  )

  /** New recovery codes, which invalidate the old ones. */
  .post(
    '/settings/two-factor/recovery-codes',
    async ({ body, request }) => {
      const answer = await api().generateBackupCodes({
        body: { password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/two-factor')
          .withErrors({ 'two-factor': await messageFrom(answer, 'That password did not match.') })
          .toResponse()
      }

      const generated = (await answer.json()) as { backupCodes?: string[] }

      return redirect('/settings/two-factor')
        .with('two-factor.pending', { uri: '', secret: '', codes: generated.backupCodes ?? [] })
        .seeOther()
        .toResponse()
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ password: t.String() })
    }
  )

  .delete(
    '/settings/two-factor',
    async ({ body, request }) => {
      const answer = await api().disableTwoFactor({
        body: { password: body.password },
        headers: request.headers,
        asResponse: true
      })

      if (!answer.ok) {
        return redirect('/settings/two-factor')
          .withErrors({ 'two-factor': await messageFrom(answer, 'That password did not match.') })
          .toResponse()
      }

      return withSession(
        answer,
        await redirect('/settings/two-factor?off=1').seeOther().toResponse()
      )
    },
    {
      ...middleware('auth', 'password.confirm'),
      body: t.Object({ password: t.String() })
    }
  )

/**
 * The base32 secret out of the URI, for typing in by hand.
 *
 * Parsed rather than asked for: `enableTwoFactor` returns the URI and nothing
 * else, and every authenticator app offers a manual entry box for the days the
 * camera will not focus. `otpauth://` is not a scheme `new URL` will parse a
 * query out of, hence the swap.
 */
function secretFrom(uri: string): string {
  try {
    return new URL(uri.replace('otpauth://', 'https://')).searchParams.get('secret') ?? ''
  } catch {
    return ''
  }
}
