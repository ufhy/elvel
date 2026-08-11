import { ServiceProvider } from '@elysian/core'
import { ConnectionManager } from './connection/manager.ts'
import { MakeMigrationCommand } from './console/make-migration.ts'
import { MigrateCommand } from './console/migrate.ts'
import { MigrateFreshCommand } from './console/migrate-fresh.ts'
import { MigrateRefreshCommand } from './console/migrate-refresh.ts'
import { MigrateResetCommand } from './console/migrate-reset.ts'
import { MigrateRollbackCommand } from './console/migrate-rollback.ts'
import { MigrateStatusCommand } from './console/migrate-status.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    db: ConnectionManager
  }
}

export class DatabaseServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('db', (app) => new ConnectionManager(app))
  }

  override async boot(): Promise<void> {
    // Connections open lazily, so nothing is resolved here: a booted app with a
    // misconfigured database should still be able to run `migrate`.
    if (!this.app.bound('artisan')) return

    this.app
      .make('artisan')
      .register(
        MigrateCommand,
        MigrateRollbackCommand,
        MigrateResetCommand,
        MigrateRefreshCommand,
        MigrateFreshCommand,
        MigrateStatusCommand,
        MakeMigrationCommand
      )
  }
}
