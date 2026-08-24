/*
 * Not rendered in this kit, and here only because an import needs it.
 *
 * `Settings/SettingsPageController` answers /settings/profile with the document the Vue
 * client boots from, and `frontend/src/views/settings/Profile.vue` is what you edit. The
 * auth kit's controller — which this kit uses unchanged, actions and all — still
 * imports this file, so the file has to exist.
 */
export function Profile(_props: {
  title: string
  name: string
  email: string
  emailVerified: boolean
  pending: boolean
  saved: boolean
  error?: string
}): string {
  return ''
}
