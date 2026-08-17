import { Command } from '@elyvel/console'

/**
 * `queue:monitor` — how much work is waiting, against a threshold.
 *
 * `queue:size` reports one number for a person to read; this reports several for
 * a scheduler to act on, and exits non-zero when any of them is over the limit.
 * A queue quietly growing is the failure this catches: nothing is broken, jobs
 * are being accepted, and they are simply never being finished.
 */
export class QueueMonitorCommand extends Command {
  static override signature =
    'queue:monitor {queues : Comma-separated queue names} {--connection= : The connection to measure} {--max=1000 : The size above which this is a failure} {--json : Output as JSON}'

  static override description = 'Report the size of the given queues against a threshold'

  async handle(): Promise<number> {
    const manager = this.app.make('queue')
    const connection = this.stringOption('connection')
    const driver = manager.connection(connection === '' ? undefined : connection)
    const max = Number(this.stringOption('max', '1000'))

    const queues = this.argument('queues')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)

    const sizes: Array<{ queue: string; size: number }> = []

    for (const queue of queues) {
      sizes.push({ queue, size: await driver.size(queue) })
    }

    if (this.flag('json')) {
      this.line(JSON.stringify({ max, queues: sizes }, null, 2))
    } else {
      this.line()
      this.table(
        ['QUEUE', 'SIZE', 'STATUS'],
        sizes.map((one) => [one.queue, String(one.size), one.size > max ? 'OVER' : 'ok'])
      )
      this.line()
    }

    const over = sizes.filter((one) => one.size > max)

    for (const one of over) {
      this.error(`[${one.queue}] has ${one.size} job(s) waiting, above ${max}.`)
    }

    // The events a scheduler would hang an alert on, dispatched either way so a
    // listener sees the recovery as well as the breach.
    this.app.bound('events') &&
      (
        this.app.make('events' as never) as { dispatch(name: string, payload: unknown): unknown }
      ).dispatch('queue.monitored', { max, queues: sizes })

    return over.length > 0 ? 1 : 0
  }
}
