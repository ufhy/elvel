import { Command } from '@elvel/console'
import { cacheOf, PAUSE_KEY, PAUSE_TTL } from '../pause.ts'

/**
 * `lens:pause` — stop recording without editing config or restarting.
 *
 * Telescope's command, and Telescope's mechanism: a cache key, so it survives a
 * restart and reaches every worker without a deploy. The thirty-day expiry is
 * Telescope's too, and it is a kindness — a pause somebody forgot about is a
 * recorder that quietly stopped working for a month, not forever.
 */
export class LensPauseCommand extends Command {
  static override signature = 'lens:pause'

  static override description = 'Pause Lens recording'

  async handle(): Promise<number> {
    const cache = cacheOf(this.app)

    if (cache === undefined) {
      this.error('Pausing needs @elvel/cache, which is not installed.')

      return 1
    }

    await cache.store().put(PAUSE_KEY, true, PAUSE_TTL)
    this.app.make('lens').setPaused(true)

    this.output.tag('INFO', 'Lens recording paused.')

    return 0
  }
}
