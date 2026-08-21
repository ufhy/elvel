import { controller } from '@elvel/core'
import { middleware } from '@elvel/http'
import { view } from '@elvel/view'
import { Appearance } from '../../../../resources/views/pages/settings/appearance.tsx'

/**
 * The appearance setting.
 *
 * One route, and no route to submit to. The choice is stored in the browser —
 * `localStorage`, written by `resources/js/app.ts` and read by the inline script
 * in `components/layout.tsx` before the first paint — so there is nothing for the
 * server to save and nothing for it to validate.
 *
 * It is still behind `auth`, because it sits inside the settings area: a page
 * that renders the account's sidebar and its own account menu has no business
 * answering a guest.
 */
export default controller('settings-appearance').get(
  '/settings/appearance',
  () => view(Appearance, { title: 'Appearance' }),
  middleware('auth')
)
