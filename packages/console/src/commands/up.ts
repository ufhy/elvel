import { Command } from '../command.ts'

/** `artisan up` — start answering requests again. */
export class UpCommand extends Command {
  static override signature = 'up'

  static override description = 'Bring the application out of maintenance mode'

  async handle(): Promise<number> {
    const maintenance = this.app.make('maintenance')

    if (!(await maintenance.deactivate())) {
      this.output.tag('INFO', 'Application is already up.')

      return 0
    }

    if (this.app.bound('events')) {
      await this.app.make('events').dispatch('maintenance.disabled')
    }

    this.output.tag('INFO', 'Application is now live.')

    return 0
  }
}
