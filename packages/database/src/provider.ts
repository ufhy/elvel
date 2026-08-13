import { ServiceProvider } from '@elysian/core'
import { ConnectionManager } from './connection/manager.ts'
import { DbSeedCommand } from './console/db-seed.ts'
import { DbShowCommand } from './console/db-show.ts'
import { DbTableCommand } from './console/db-table.ts'
import { MakeFactoryCommand } from './console/make-factory.ts'
import { MakeMigrationCommand } from './console/make-migration.ts'
import { MakeModelCommand } from './console/make-model.ts'
import { MakeSeederCommand } from './console/make-seeder.ts'
import { MigrateCommand } from './console/migrate.ts'
import { MigrateFreshCommand } from './console/migrate-fresh.ts'
import { MigrateInstallCommand } from './console/migrate-install.ts'
import { MigrateRefreshCommand } from './console/migrate-refresh.ts'
import { MigrateResetCommand } from './console/migrate-reset.ts'
import { MigrateRollbackCommand } from './console/migrate-rollback.ts'
import { MigrateStatusCommand } from './console/migrate-status.ts'
import { SchemaDumpCommand } from './console/schema-dump.ts'
import { Model } from './model/model.ts'

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
    // A model reaches the container for notifications and encryption.
    Model.useApplication(this.app)

    // Models resolve their connection lazily through the manager, so a model
    // file can be imported before the database is reachable.
    Model.setConnectionResolver((name) => this.app.make('db').connection(name))
    Model.setEventDispatcher(
      this.app.bound('events') ? (this.app.make('events' as never) as never) : undefined
    )

    // Connections open lazily, so nothing is resolved here: a booted app with a
    // misconfigured database should still be able to run `migrate`.
    if (!this.app.bound('artisan')) return

    this.app
      .make('artisan')
      .register(
        MigrateCommand,
        SchemaDumpCommand,
        MigrateRollbackCommand,
        MigrateResetCommand,
        MigrateRefreshCommand,
        MigrateFreshCommand,
        MigrateStatusCommand,
        MigrateInstallCommand,
        MakeMigrationCommand,
        MakeModelCommand,
        MakeSeederCommand,
        MakeFactoryCommand,
        DbSeedCommand,
        DbShowCommand,
        DbTableCommand
      )
  }
}
