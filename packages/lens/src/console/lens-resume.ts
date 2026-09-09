import { Command } from '@elvel/console'
import { cacheOf, PAUSE_KEY } from '../pause.ts'

/** `lens:resume` — undo `lens:pause`. */
export class LensResumeCommand extends Command {
  static override signature = 'lens:resume'

  static override description = 'Resume Lens recording'

  async handle(): Promise<number> {
    const cache = cacheOf(this.app)

    if (cache === undefined) {
      this.error('Resuming needs @elvel/cache, which is not installed.')

      return 1
    }

    await cache.store().forget(PAUSE_KEY)
    this.app.make('lens').setPaused(false)

    this.output.tag('INFO', 'Lens recording resumed.')

    return 0
  }
}
