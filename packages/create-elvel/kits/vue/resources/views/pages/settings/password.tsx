/*
 * Not rendered in this kit, and here only because an import needs it.
 *
 * No route reaches this file. `routes/view.ts` answers every address with the
 * shell the Vue client boots from, and `frontend/src/views/settings/Password.vue` is the page
 * you edit. What still points here is an `import` in the auth kit's controller,
 * which this kit uses unchanged for its actions — so the file has to exist, and
 * has nothing to render.
 *
 * The full page it replaced is in the `auth` kit if you ever want it back.
 */
export function Password(_props: { title: string; saved: boolean; error?: string }): string {
  return ''
}
