import { Command } from '@elysian/console'

/**
 * Exists so `bun run smoke` proves application command discovery still works:
 * this class is never registered by hand anywhere.
 */
export class Ping extends Command {
  static override signature =
    'ping {target=world : Who to greet} {--loud : Shout it} {--repeat=1 : How many times}'

  static override description = 'Reply to prove command discovery works'

  handle(): number {
    const target = this.argument('target')
    const repeat = Number(this.stringOption('repeat', '1'))

    for (let index = 0; index < repeat; index += 1) {
      const message = `pong ${target}`
      this.line(this.flag('loud') ? message.toUpperCase() : message)
    }

    return 0
  }
}
