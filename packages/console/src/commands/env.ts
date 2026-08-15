import { Command } from '../command.ts'

/** `env` — which environment this application thinks it is in. */
export class EnvironmentCommand extends Command {
  static override signature = 'env'

  static override description = 'Show the current environment'

  async handle(): Promise<number> {
    this.line()
    this.output.pairs([
      ['Environment', this.app.config.get<string>('app.env', 'production')],
      ['Debug', String(this.app.config.get<boolean>('app.debug', false))],
      ['URL', this.app.config.get<string>('app.url', '')]
    ])
    this.line()

    return 0
  }
}
