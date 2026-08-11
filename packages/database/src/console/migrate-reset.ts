import { MigrationCommand } from './base.ts'

export class MigrateResetCommand extends MigrationCommand {
  static override signature =
    'migrate:reset {--database= : The connection to use} {--pretend : Show what would be reversed} {--force : Run without confirming in production}'

  static override description = 'Reverse every database migration'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const reverted = await (await this.migrator()).reset(this.flag('pretend'))
    this.success(`${reverted.length} migration(s) rolled back.`)

    return 0
  }
}
