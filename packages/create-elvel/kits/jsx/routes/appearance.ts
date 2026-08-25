import { Route } from '@elvel/http'
import AppearanceController from '../app/Http/Controllers/Settings/AppearanceController.ts'

/**
 * This kit's one route of its own — the theme picker.
 *
 * Its own file rather than an edit to `routes/settings.ts`, which this kit
 * inherits from the auth layer unchanged. Adding a line there would mean shipping
 * a copy of all fifteen settings routes to change one of them, and the two copies
 * would drift the first time either side moved.
 *
 * A theme is a Tailwind concern, which is why the auth kit has no such page: it
 * ships no stylesheet to theme.
 */
Route.middleware('auth').group(() => {
  Route.get('/settings/appearance', [AppearanceController, 'show']).name('settings.appearance')
})
