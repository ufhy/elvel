import type { Model } from '../model/model.ts'
import { MigrationCommand } from './base.ts'
import { loadModels } from './model-show.ts'

/**
 * Delete what a model says it no longer needs — Laravel's `model:prune`.
 *
 * A model opts in by defining `static prunable()`; one that does not is skipped
 * rather than guessed at. That is the whole safety property: a command that
 * decided for itself what "expired" meant would eventually be wrong about
 * somebody's audit table, and this is a command people put on a schedule.
 *
 * Rows are deleted one at a time so model events fire — the same trade
 * `Model.destroy()` makes, and for the same reason: a cache flush or an audit
 * line written as a listener never runs behind a bulk `delete where`.
 */
export class ModelPruneCommand extends MigrationCommand {
  static override signature =
    'model:prune {--model=* : Only these models} {--except=* : Skip these models} {--chunk=1000 : Rows to load at a time} {--pretend : Report what would be deleted, without deleting it}'

  static override description = 'Prune models that are no longer needed'

  async handle(): Promise<number> {
    const only = this.arrayOption('model').map((name) => name.toLowerCase())
    const except = this.arrayOption('except').map((name) => name.toLowerCase())
    const chunk = Math.max(1, Number(this.stringOption('chunk', '1000')))

    const models = (await loadModels(this.app.appPath('Models')))
      .filter((model) => only.length === 0 || only.includes(model.name.toLowerCase()))
      .filter((model) => !except.includes(model.name.toLowerCase()))

    const prunable = models.filter((model) => typeof model.prunable === 'function')

    if (prunable.length === 0) {
      this.warn('No model defines prunable().')
      return 0
    }

    const rows: string[][] = []

    for (const model of prunable) {
      const pruned = await this.prune(model, chunk)

      rows.push([model.name, String(pruned)])
    }

    this.line()
    this.table([this.flag('pretend') ? 'MODEL' : 'MODEL', 'ROWS'], rows)
    this.line()

    const total = rows.reduce((sum, [, count]) => sum + Number(count), 0)

    this.success(
      this.flag('pretend') ? `${total} row(s) would be pruned.` : `${total} row(s) pruned.`
    )

    return 0
  }

  private async prune(model: typeof Model, chunk: number): Promise<number> {
    let pruned = 0

    for (;;) {
      // A fresh query each round: the previous one's rows are gone, so an offset
      // would step over the rows that moved into its place.
      const batch = await (model.prunable as () => ReturnType<typeof model.query>)()
        .limit(chunk)
        .get()

      if (batch.count() === 0) return pruned

      if (this.flag('pretend')) return pruned + batch.count()

      for (const row of batch.all()) await (row as Model).delete()

      pruned += batch.count()
    }
  }
}
