import { MigrationCommand } from './base.ts'

export class MigrateCommand extends MigrationCommand {
  static override signature =
    'migrate {--database= : The connection to use} {--step : Record each migration in its own batch} {--pretend : Show the migrations that would run} {--force : Run without confirming in production}'

  static override description = 'Run the pending database migrations'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const migrator = await this.migrator()
    const applied = await migrator.run({
      step: this.flag('step'),
      pretend: this.flag('pretend')
    })

    if (applied.length > 0) this.success(`${applied.length} migration(s) applied.`)

    return 0
  }
}
