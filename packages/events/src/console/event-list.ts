import { Command } from '@elyvel/console'

/**
 * `event:list` — what is listening, and to what.
 *
 * The question this answers is "I dispatched it and nothing happened". A
 * listener that was never registered looks identical to one that ran and did
 * nothing, and the difference is the first thing to check.
 *
 * Wildcards are listed apart from exact names because they match events that do
 * not exist yet; folding them into one list would hide the very listener that is
 * hardest to find by reading the code.
 */
export class EventListCommand extends Command {
  static override signature = 'event:list {--json : Output as JSON}'

  static override description = 'List the registered event listeners'

  async handle(): Promise<number> {
    const { exact, wildcards } = this.app.make('events').registered()

    if (this.flag('json')) {
      this.line(JSON.stringify({ exact, wildcards }, null, 2))

      return 0
    }

    if (exact.length === 0 && wildcards.length === 0) {
      this.warn('Nothing is listening. Listeners are registered in a service provider.')

      return 0
    }

    if (exact.length > 0) {
      this.line()
      this.table(
        ['EVENT', 'LISTENERS'],
        exact.sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => [name, String(count)])
      )
    }

    if (wildcards.length > 0) {
      this.line()
      this.table(
        ['PATTERN', 'LISTENERS'],
        wildcards
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => [name, String(count)])
      )
    }

    this.line()

    return 0
  }
}
