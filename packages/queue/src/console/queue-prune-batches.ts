import { Command } from '@elvel/console'

/**
 * `queue:prune-batches` — drop batch records that are no longer worth keeping.
 *
 * Finished batches are pruned by default, because they are the ones that pile
 * up: a nightly import that runs for a year leaves 365 rows nobody reads. The
 * other two are opt-in and aged separately, because they mean something.
 *
 * An **unfinished** batch is a worker that died mid-run or a job that failed with
 * `allowFailures` off; a **cancelled** one never finishes by design, since its
 * remaining jobs are skipped as they are reserved rather than deleted. Both are
 * worth noticing before they are swept, which is why neither goes by default.
 */
export class QueuePruneBatchesCommand extends Command {
  static override signature =
    'queue:prune-batches {--hours=24 : Retain finished batches for this many hours} {--unfinished= : Also drop unfinished batches older than this many hours} {--cancelled= : Also drop cancelled batches older than this many hours}'

  static override description = 'Prune stale entries from the batches table'

  async handle(): Promise<number> {
    const batches = this.app.make('queue').batches()

    const hours = Number(this.stringOption('hours') || 24)
    const pruned = await batches.prune(hours * 3600)

    this.output.tag('INFO', `Deleted ${pruned} finished batch(es).`)

    const unfinished = this.stringOption('unfinished')
    if (unfinished !== '') {
      const deleted = await batches.pruneUnfinished(Number(unfinished) * 3600)

      this.output.tag('INFO', `Deleted ${deleted} unfinished batch(es).`)
    }

    const cancelled = this.stringOption('cancelled')
    if (cancelled !== '') {
      const deleted = await batches.pruneCancelled(Number(cancelled) * 3600)

      this.output.tag('INFO', `Deleted ${deleted} cancelled batch(es).`)
    }

    return 0
  }
}
