import { Command } from '@elyvel/console'
import type { ConnectionManager } from '../connection/manager.ts'
import { Migrator } from '../migrations/migrator.ts'
import { MigrationRepository } from '../migrations/repository.ts'

/**
 * Shared plumbing for the migrate:* commands: resolve the connection, build a
 * migrator whose notes stream straight to the terminal.
 */
export abstract class MigrationCommand extends Command {
  protected async migrator(): Promise<Migrator> {
    const manager = this.app.make('db') as ConnectionManager
    const name = this.stringOption('database')
    const connection = await manager.connection(name === '' ? undefined : name)

    const table = this.app.config.get<string>('database.migrations', 'migrations')

    return new Migrator(connection, new MigrationRepository(connection, table), this.paths(), {
      onNote: (note) => this.output.tag('INFO', note)
    })
  }

  protected paths(): string[] {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured.length > 0 ? configured : [this.app.basePath('database', 'migrations')]
  }

  /** Refuse to run destructively in production unless forced, as Artisan does. */
  protected async confirmInProduction(): Promise<boolean> {
    if (!this.app.isProduction() || this.flag('force')) return true

    this.warn('Application is in production.')

    return this.confirm('Do you really wish to run this command?', false)
  }
}
