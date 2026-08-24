/*
 * Not rendered in this kit, and here only because an import needs it.
 *
 * `AuthPageController` answers /sign-up with the document the Vue client boots from,
 * and the Vue page at `frontend/src/views/auth/SignUp.vue` is what you edit. The auth
 * kit's controller — which this kit uses unchanged, actions and all — still imports
 * this file, so the file has to exist.
 *
 * The full page it replaced is in the `auth` kit if you ever want it back: mount
 * `AuthPageController` earlier than that controller in `routes/web.ts`, or drop it,
 * and the server-rendered screen returns.
 */
export function SignUp(_props: { title: string; error?: string }): string {
  return ''
}
