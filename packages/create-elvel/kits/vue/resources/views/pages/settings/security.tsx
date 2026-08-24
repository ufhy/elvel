/*
 * Not rendered in this kit, and here only because an import needs it.
 *
 * `Settings/SettingsPageController` answers /settings/security with the document the Vue
 * client boots from, and `frontend/src/views/settings/Security.vue` is what you edit. The
 * auth kit's controller — which this kit uses unchanged, actions and all — still
 * imports this file, so the file has to exist.
 */
export function Security(_props: {
  title: string
  sessions: unknown[]
  revoked: boolean
  error?: string
}): string {
  return ''
}
