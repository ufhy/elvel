import type { ApplicationContract } from '@elvel/contracts'
import type { Recorder } from '../recorder.ts'

export type BarState = {
  /** Whether the bar runs at all. */
  on: boolean
  /**
   * Whether each request must still pass `authorise()` before the bar appears.
   *
   * True only when the bar was switched on by hand while debug mode is off.
   */
  gated: boolean
  /** One sentence for `lens:status`. */
  reason: string
}

/**
 * Debugbar's rule, plus the lock Debugbar is missing.
 *
 * `DEBUGBAR_ENABLED` unset means "follow `APP_DEBUG`", and that is the right
 * default: an inspection bar belongs to the same switch as stack traces in the
 * browser. Setting it explicitly wins, because somebody debugging a staging box
 * has a real reason and refusing them would only teach them to ship
 * `APP_DEBUG=true`, which is worse.
 *
 * The lock is what happens then. An `ENABLED=true` on a production box that hands
 * the bar to everyone who loads a page is how
 * every Debugbar leak has ever happened. Here that combination — forced on,
 * debug off — makes the bar answer only to a request that passes the
 * application's own `authorise()`. The config is honoured; the page is not
 * given away.
 */
export function barState(app: ApplicationContract): BarState {
  const enabled = app.config.get<boolean | null>('lens.bar.enabled', null)
  const debug = app.hasDebugModeEnabled()

  if (enabled === false) {
    return { on: false, gated: false, reason: 'off — lens.bar.enabled is false' }
  }

  if (enabled === true && !debug) {
    return { on: true, gated: true, reason: 'on — forced by LENS_BAR, gated by authorise()' }
  }

  if (enabled === true) return { on: true, gated: false, reason: 'on — LENS_BAR' }

  return debug
    ? { on: true, gated: false, reason: 'on — following APP_DEBUG' }
    : { on: false, gated: false, reason: 'off — APP_DEBUG is false' }
}

/** May this particular request see the bar? */
export async function barAllows(
  state: BarState,
  lens: Recorder,
  request: Request
): Promise<boolean> {
  if (!state.on) return false
  if (!state.gated) return true

  return lens.check(request)
}
