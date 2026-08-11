import { MigrationCommand } from './base.ts'

export class MigrateFreshCommand extends MigrationCommand {
  static override signature =
    'migrate:fresh {--database= : The connection to use} {--force : Run without confirming in production}'

  static override description = 'Drop every table and re-run the migrations'

  async handle(): Promise<number> {
    if (!(await this.confirmInProduction())) return 1

    const applied = await (await this.migrator()).fresh()
    this.success(`${applied.length} migration(s) applied.`)

    return 0
  }
}
