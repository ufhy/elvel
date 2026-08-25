import { api, messageFrom, withSession } from '@elvel/auth'
import { currentScope, errors, redirect } from '@elvel/http'
import { view } from '@elvel/view'
import { TwoFactorChallenge } from '../../../../resources/views/pages/auth/two-factor-challenge.tsx'

type Code = { body: { code: string }; request: Request }

/**
 * The second step of a sign-in, for an account that asked for one.
 *
 * `signInEmail` answers `{ twoFactorRedirect: true }` instead of a session when
 * the account has two-factor on. What it *does* send is a short-lived
 * `better-auth.two_factor` cookie, and `SignInController` copies it across before
 * redirecting here — so the person arriving is still a guest, holding a cookie
 * that says which account is halfway in.
 *
 * `guest`, therefore, and not `auth`: there is no session yet. That is also why
 * `routes/auth.ts` throttles both posts. A six-digit code is 1,000,000 guesses,
 * which is a small number if nobody is counting.
 */
export default class TwoFactorChallengeController {
  create() {
    return view(TwoFactorChallenge, {
      title: 'Two-factor',
      error: errors().first('code')
    })
  }

  async store({ body, request }: Code) {
    const answer = await api().verifyTOTP({
      body: { code: body.code },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      return redirect('/two-factor-challenge')
        .withErrors({ code: await messageFrom(answer, 'That code did not work.') })
        .toResponse()
    }

    /**
     * A new session id, now that this browser is somebody.
     *
     * Session fixation: an id chosen before signing in is an id somebody else may
     * have chosen, and if it still names the session afterwards then whoever chose
     * it is signed in as this user. The CSRF token rotates with it, so a token
     * picked up while signed out no longer authorises writes while signed in.
     *
     * Every path that turns an anonymous browser into a signed-in one needs this,
     * not just the password one — and the account with two factors is the one most
     * worth protecting. Written out in both methods rather than shared: a test in
     * `create-elvel` counts a `regenerate()` per landing on `/dashboard`, and the
     * value of that check is that it is mechanical.
     */
    await currentScope()?.session.regenerate()

    return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
  }

  /**
   * A recovery code, for the phone that is not in the room.
   *
   * Its own route rather than one field that guesses: a recovery code and a TOTP
   * code go to different endpoints, and telling them apart by length is the kind
   * of rule that breaks the first time either format changes. Each code works
   * once — better-auth deletes it as it accepts it.
   */
  async recovery({ body, request }: Code) {
    const answer = await api().verifyBackupCode({
      body: { code: body.code },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      return redirect('/two-factor-challenge')
        .withErrors({ code: await messageFrom(answer, 'That recovery code did not work.') })
        .toResponse()
    }

    // The same rotation, for the same reason as above: this path signs somebody
    // in too, so the id it arrived with must not be the id it leaves with.
    await currentScope()?.session.regenerate()

    return withSession(answer, await redirect('/dashboard').seeOther().toResponse())
  }
}
