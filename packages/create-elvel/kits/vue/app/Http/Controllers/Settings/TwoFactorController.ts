import { api, messageFrom, withSession } from '@elvel/auth'
import { currentScope, redirect } from '@elvel/http'

type WithPassword = { body: { password: string }; request: Request }

/**
 * This kit's own copy, with the page removed.
 *
 * The auth layer's version of this class renders a screen *and* performs the
 * action, so it imports its `.tsx` page at the top of the module — and that import
 * is evaluated the moment a routes file mentions the class, whether or not the
 * page method is ever routed. This kit renders its screens in Vue, so carrying
 * that layer's file meant carrying an empty `.tsx` beside it purely to satisfy an
 * import. Measured: delete the page and the application dies at load.
 *
 * So the actions live here instead, copied verbatim, and nothing in this kit
 * imports a page it does not render. The cost is a copy: an action fixed in the
 * auth kit has to be fixed here too.
 */
/**
 * Turning two-factor authentication on and off.
 *
 * `routes/settings.ts` puts every one of these behind `password.confirm` as well
 * as `auth`, for the same reason the sessions page is: a borrowed unlocked browser
 * must not be able to add a factor its owner does not hold, nor remove the one
 * they do. better-auth asks for the password again on every one of these endpoints
 * anyway; that stops the *page* being reachable without it.
 *
 * Enrolment is two steps, because better-auth makes it two steps and it is right
 * to. `enableTwoFactor` hands back a secret and recovery codes but leaves the
 * account alone; only a correct code from the authenticator turns it on. Without
 * that confirmation a mistyped setup would lock somebody out of their own
 * account — which is the one failure this feature must not have.
 */
export default class TwoFactorController {
  /**
   * Step one: get a secret, and show it.
   *
   * Nothing about the account changes here. What comes back is a TOTP URI, the
   * secret inside it for anybody typing it in by hand, and ten recovery codes —
   * which are shown once, here, and never again.
   */
  async enable({ body, request }: WithPassword) {
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
  }

  /**
   * Step two: the first code, which is what actually turns it on.
   *
   * The same endpoint a sign-in challenge uses. Called with a session already in
   * hand it confirms the enrolment instead of completing a sign-in.
   */
  async confirm({ body, request }: { body: { code: string }; request: Request }) {
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

    return withSession(answer, await redirect('/settings/two-factor?on=1').seeOther().toResponse())
  }

  /** New recovery codes, which invalidate the old ones. */
  async recoveryCodes({ body, request }: WithPassword) {
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
  }

  async disable({ body, request }: WithPassword) {
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

    return withSession(answer, await redirect('/settings/two-factor?off=1').seeOther().toResponse())
  }
}

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
