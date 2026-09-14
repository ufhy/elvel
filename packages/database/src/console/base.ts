import { Command } from '@elvel/console'
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

  /**
   * The guard lives on `Command` now, so every command has it.
   *
   * Kept as a member here only because migration commands call it by this name;
   * the behaviour — and the non-interactive refusal — is the base class's.
   */
  protected paths(): string[] {
    const configured = this.app.config.get<string[]>('database.migrationPaths', [])

    return configured.length > 0 ? configured : [this.app.basePath('database', 'migrations')]
  }
}
