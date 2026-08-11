import pc from 'picocolors'
import { MigrationCommand } from './base.ts'

export class MigrateStatusCommand extends MigrationCommand {
  static override signature = 'migrate:status {--database= : The connection to use}'

  static override description = 'Show which migrations have run'

  async handle(): Promise<number> {
    const status = await (await this.migrator()).status()

    if (status.length === 0) {
      this.warn('No migrations found.')
      return 0
    }

    this.line()
    this.table(
      ['RAN', 'BATCH', 'MIGRATION'],
      status.map((entry) => [
        entry.ran ? pc.green('yes') : pc.yellow('no'),
        entry.batch === undefined ? '-' : String(entry.batch),
        entry.name
      ])
    )
    this.line()

    return 0
  }
}
