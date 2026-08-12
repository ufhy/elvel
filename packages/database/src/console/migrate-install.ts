import { MigrationCommand } from './base.ts'

export class MigrateInstallCommand extends MigrationCommand {
  static override signature = 'migrate:install {--database= : The connection to use}'

  static override description = 'Create the migration tracking table'

  async handle(): Promise<number> {
    await (await this.migrator()).install()

    return 0
  }
}
