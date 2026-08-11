import { MigrationCommand } from './base.ts'

export class MigrateRollbackCommand extends MigrationCommand {
  static override signature =
    'migrate:rollback {--database= : The connection to use} {--step= : How many batches to reverse} {--batch= : Reverse one specific batch} {--pretend : Show what would be reversed} {--force : Run without confirming in production}'

  static override description = 'Reverse the last database migration batch'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const step = this.stringOption('step')
    const batch = this.stringOption('batch')

    const reverted = await (await this.migrator()).rollback({
      step: step === '' ? undefined : Number(step),
      batch: batch === '' ? undefined : Number(batch),
      pretend: this.flag('pretend')
    })

    if (reverted.length > 0) this.success(`${reverted.length} migration(s) rolled back.`)

    return 0
  }
}
