import { Command } from '@elysian/console'

/** `queue:flush` — clear the failed jobs, optionally only the older ones. */
export class QueueFlushCommand extends Command {
  static override signature = 'queue:flush {--hours= : Only flush jobs older than this}'

  static override description = 'Delete all of the failed queue jobs'

  async handle(): Promise<number> {
    const hours = this.stringOption('hours')

    const flushed = await this.app
      .make('queue')
      .failed.flush(hours === '' ? undefined : Number(hours))

    this.output.tag('INFO', `Deleted ${flushed} failed job(s).`)

    return 0
  }
}
