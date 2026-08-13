import { unlink } from 'node:fs/promises'
import { Command } from '../command.ts'

/** `config:clear` — drop the cached configuration and read `config/` again. */
export class ConfigClearCommand extends Command {
  static override signature = 'config:clear'

  static override description = 'Remove the cached configuration file'

  async handle(): Promise<number> {
    const path = this.app.basePath('bootstrap', 'cache', 'config.json')

    if (!(await Bun.file(path).exists())) {
      this.comment('No configuration cache to clear.')

      return 0
    }

    await unlink(path)
    this.output.tag('INFO', 'Configuration cache cleared.')

    return 0
  }
}
