import { api, messageFrom, userOf, withSession } from '@elvel/auth'
import { redirect } from '@elvel/http'

type Details = { name: string; email: string }

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
 * The name and address on the account, and closing it.
 *
 * Laravel's starter kit keeps profile and security in a `Settings` directory of
 * their own with a `routes/settings.php` beside them. This is that split, and now
 * the route file too: `routes/settings.ts`.
 *
 * Deleting lives here rather than with security because it is the last thing on
 * the profile page — and it asks for the password, which is what makes it safe
 * to leave on a page somebody reaches with an unlocked browser.
 */
export default class ProfileController {
  async update(context: { body: Details; request: Request }) {
    const { body, request } = context
    const person = userOf(context as never)

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
  }

  async destroy({ body, request }: { body: { password: string }; request: Request }) {
    const answer = await api().deleteUser({
      body: { password: body.password },
      headers: request.headers,
      asResponse: true
    })

    if (!answer.ok) {
      // Under `password`, which is the field this form has. Filed under `name` it
      // marked the wrong input on a form that has no name field at all.
      return redirect('/settings/profile')
        .withErrors({ password: await messageFrom(answer, 'That password was wrong.') })
        .toResponse()
    }

    return withSession(answer, await redirect('/').seeOther().toResponse())
  }
}
