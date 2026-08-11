import { MigrationCommand } from './base.ts'

export class MigrateRefreshCommand extends MigrationCommand {
  static override signature =
    'migrate:refresh {--database= : The connection to use} {--step= : How many batches to reverse before re-running} {--force : Run without confirming in production}'

  static override description = 'Reverse and re-run the database migrations'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const migrator = await this.migrator()
    const step = this.stringOption('step')

    if (step === '') await migrator.reset()
    else await migrator.rollback({ step: Number(step) })

    const applied = await migrator.run()
    this.success(`${applied.length} migration(s) applied.`)

    return 0
  }
}
