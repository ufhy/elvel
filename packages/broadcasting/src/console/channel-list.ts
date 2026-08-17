import { Command } from '@elvel/console'

/**
 * `channel:list` — the private channels, in matching order.
 *
 * Order is the whole point. The first pattern that matches decides who may
 * listen, so a broad `{anything}` declared above a specific channel quietly
 * takes over every authorization the specific one was written for — and nothing
 * about reading the file top to bottom makes that obvious once the declarations
 * are spread across a provider and a couple of modules.
 */
export class ChannelListCommand extends Command {
  static override signature = 'channel:list {--json : Output as JSON}'

  static override description = 'List the broadcast channels and the order they match in'

  async handle(): Promise<number> {
    const patterns = this.app.make('channels').patterns()

    if (this.flag('json')) {
      this.line(JSON.stringify({ channels: patterns }, null, 2))

      return 0
    }

    if (patterns.length === 0) {
      this.warn('No channels declared. Add them in a service provider with channels().channel().')

      return 0
    }

    this.line()
    this.table(
      ['#', 'PATTERN', 'PARAMETERS'],
      patterns.map((pattern, index) => [
        String(index + 1),
        pattern,
        [...pattern.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).join(', ') || '\u2014'
      ])
    )
    this.line()

    return 0
  }
}
