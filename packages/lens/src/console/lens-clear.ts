import { Command } from '@elvel/console'
import { isClearable } from '../contracts.ts'

/** `lens:clear` — drop every entry, every tag, and every monitored tag. */
export class LensClearCommand extends Command {
  static override signature = 'lens:clear'

  static override description = 'Delete all Lens entries'

  async handle(): Promise<number> {
    const repository = this.app.make('lens.entries')

    if (!isClearable(repository)) {
      this.error('The configured Lens driver cannot be cleared.')

      return 1
    }

    await repository.clear()

    this.output.tag('INFO', 'Lens entries cleared.')

    return 0
  }
}
