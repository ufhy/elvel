import { ServiceProvider } from '@elvel/core'
import { LensClearCommand } from './console/lens-clear.ts'
import { LensInstallCommand } from './console/lens-install.ts'
import { LensPauseCommand } from './console/lens-pause.ts'
import { LensPruneCommand } from './console/lens-prune.ts'
import { LensResumeCommand } from './console/lens-resume.ts'
import { LensTableCommand } from './console/lens-table.ts'
import type { EntriesRepository } from './contracts.ts'
import { lensDashboard } from './http/dashboard.ts'
import { lensPlugin } from './http/plugin.ts'
import { lensRoutes } from './http/routes.ts'
import { refreshPause } from './pause.ts'
import { Recorder } from './recorder.ts'
import { DatabaseEntriesRepository } from './storage/database-repository.ts'
import { registerWatchers, type WatcherConfig } from './watchers/index.ts'
import { RequestWatcher } from './watchers/request.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    lens: Recorder
    'lens.entries': EntriesRepository
  }
}

/**
 * Binds the recorder and its storage, then registers the configured watchers.
 *
 * The recorder is a singleton because the filters and tag callbacks an
 * application registers must be the ones the watchers see; the per-request
 * state it manages lives in a request slot, not in the instance, so sharing it
 * across concurrent requests is safe. See `recorder.ts` for why that split is
 * not optional under Bun.
 */
export class LensServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('lens', (app) => {
      const recorder = new Recorder((error) => app.make('exception.handler').report(error))

      recorder.enable(this.config<boolean>('lens.enabled', false))

      return recorder
    })

    this.registerStorage()
  }

  override boot(): void {
    if (this.app.bound('elvel')) {
      this.app
        .make('elvel')
        .register(
          LensClearCommand,
          LensInstallCommand,
          LensPauseCommand,
          LensPruneCommand,
          LensResumeCommand,
          LensTableCommand
        )
    }

    if (!this.config<boolean>('lens.enabled', false)) return

    /**
     * Read the pause flag once at boot, and again after each flush.
     *
     * Not awaited here: `boot()` is where a server is about to start listening,
     * and a cache round trip before the first request would be paid by every
     * boot to answer a question that is almost always "no".
     */
    void refreshPause(this.app, this.app.make('lens'))

    this.app.make('lens').afterStoring(() => {
      void refreshPause(this.app, this.app.make('lens'))
    })

    const watchers = registerWatchers(
      this.app,
      this.config<WatcherConfig>('lens.watchers', {}),
      (error) => this.app.make('exception.handler').report(error)
    )

    /**
     * The plugin is what opens a batch and what flushes it.
     *
     * Mounted only when Lens is enabled, so a disabled recorder adds no hook to
     * the request path at all rather than one that returns early.
     */
    const readSide = {
      path: this.config<string>('lens.path', 'lens'),
      enabled: true,
      watchers: this.config<WatcherConfig>('lens.watchers', {})
    }

    this.use(lensDashboard(this.app, readSide))

    this.use(
      lensRoutes(this.app, {
        path: this.config<string>('lens.path', 'lens'),
        enabled: true,
        watchers: this.config<WatcherConfig>('lens.watchers', {})
      })
    )

    this.use(
      lensPlugin(this.app, {
        onlyPaths: this.config<string[]>('lens.onlyPaths', []),
        ignorePaths: this.config<string[]>('lens.ignorePaths', []),
        requestWatcher: watchers.find(
          (watcher): watcher is RequestWatcher => watcher instanceof RequestWatcher
        )
      })
    )
  }

  /**
   * Bind the driver named in `lens.driver`, or nothing.
   *
   * Nothing, and loudly: an unknown driver used to be worth a silent skip when
   * the config might name a driver a future version adds, but a recorder that
   * binds no storage records into a container miss at the end of the first
   * request. Better to say so at boot.
   */
  private registerStorage(): void {
    const driver = this.config<string>('lens.driver', 'database')

    if (driver !== 'database') {
      throw new Error(`[lens] Unsupported storage driver [${driver}]. Only [database] exists.`)
    }

    this.app.singleton('lens.entries', (app) => {
      return new DatabaseEntriesRepository(app.make('db'), {
        connection: this.config<string | undefined>('lens.storage.database.connection', undefined),
        table: 'lens_entries',
        chunk: this.config<number>('lens.storage.database.chunk', 1000)
      })
    })
  }
}
