import { ServiceProvider } from '@elvel/core'
import { Baselines } from './bar/baseline.ts'
import { type BarState, barState } from './bar/enabled.ts'
import { RequestProfiler } from './bar/profiler.ts'
import { BatchRing } from './bar/ring.ts'
import { LensClearCommand } from './console/lens-clear.ts'
import { LensInstallCommand } from './console/lens-install.ts'
import { LensPauseCommand } from './console/lens-pause.ts'
import { LensPruneCommand } from './console/lens-prune.ts'
import { LensResumeCommand } from './console/lens-resume.ts'
import { LensStatusCommand } from './console/lens-status.ts'
import { LensTableCommand } from './console/lens-table.ts'
import type { EntriesRepository } from './contracts.ts'
import { lensBar } from './http/bar.ts'
import { lensDashboard } from './http/dashboard.ts'
import { lensPlugin } from './http/plugin.ts'
import { lensRoutes } from './http/routes.ts'
import { refreshMonitoring, refreshPause } from './pause.ts'
import { flushCommandBatches, openCommandBatches } from './queue/command.ts'
import { flushJobBatches, openJobBatches } from './queue/listener.ts'
import { flushScheduleBatches, openScheduleBatches } from './queue/schedule.ts'
import { Recorder } from './recorder.ts'
import { DatabaseEntriesRepository } from './storage/database-repository.ts'
import { NullEntriesRepository } from './storage/null-repository.ts'
import { registerWatchers, type WatcherConfig } from './watchers/index.ts'
import { RequestWatcher } from './watchers/request.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    lens: Recorder
    'lens.entries': EntriesRepository
    'lens.ring': BatchRing
    'lens.baselines': Baselines
    'lens.profiler': RequestProfiler
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
  /**
   * Resolved once, in `register`, because `boot` asks three separate questions
   * of it and a config read between them could disagree.
   */
  private bar: BarState = { on: false, gated: false, reason: 'off' }

  register(): void {
    this.bar = barState(this.app)

    this.app.singleton('lens', (app) => {
      const recorder = new Recorder((error) => app.make('exception.handler').report(error))

      /**
       * The bar switches recording on by itself.
       *
       * Without this `LENS_BAR=true` would draw an empty bar on every page and
       * the person who set it would have no way of knowing that a second flag
       * was wanted. The bar *is* a reason to record; it just is not a reason to
       * write anything down, which `registerStorage` handles.
       */
      recorder.enable(this.config<boolean>('lens.enabled', false) || this.bar.on)

      return recorder
    })

    this.app.singleton(
      'lens.ring',
      () =>
        new BatchRing(
          Math.max(1, this.app.config.integer('lens.bar.requests', 20)),
          Math.max(1, this.app.config.integer('lens.bar.budget', 8 * 1024 * 1024))
        )
    )

    this.app.singleton('lens.baselines', () => new Baselines())
    this.app.singleton('lens.profiler', () => new RequestProfiler(this.app.basePath()))

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
          LensStatusCommand,
          LensTableCommand
        )
    }

    if (!this.config<boolean>('lens.enabled', false) && !this.bar.on) return

    /**
     * Read the pause flag once at boot, and again after each flush.
     *
     * Not awaited here: `boot()` is where a server is about to start listening,
     * and a cache round trip before the first request would be paid by every
     * boot to answer a question that is almost always "no".
     */
    void this.refreshState()

    this.app.make('lens').afterStoring(() => {
      void this.refreshState()
    })

    /**
     * A queued job is a unit of work like a request, and gets a batch like one.
     *
     * Registered before the watchers so that a job dispatched during boot —
     * which nothing does today, but nothing prevents — finds the listener in
     * place rather than recording into a batch nobody opened.
     */
    openJobBatches(this.app)
    openScheduleBatches(this.app)
    openCommandBatches(this.app)

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

    /**
     * After the watchers, and it has to be — see `flushScheduleBatches`. Both
     * subscribe to the terminal schedule events, and flushing before the
     * watcher has recorded would store an empty batch.
     */
    flushJobBatches(this.app)
    flushScheduleBatches(this.app)
    flushCommandBatches(this.app)

    /**
     * The dashboard belongs to Lens proper, not to the bar.
     *
     * An application running only the bar has no tables, so every page of the
     * dashboard would be the "not installed" notice. Serving nothing is the
     * honest answer, and it keeps `LENS_BAR=true` from quietly publishing a
     * route somebody did not ask for.
     */
    if (this.config<boolean>('lens.enabled', false)) {
      this.use(lensDashboard(this.app, readSide))
      this.use(lensRoutes(this.app, readSide))
    }

    if (this.bar.on) {
      this.use(
        lensBar(this.app, {
          state: this.bar,
          ring: this.app.make('lens.ring'),
          baselines: this.app.make('lens.baselines'),
          profiler: this.app.make('lens.profiler'),
          path: this.config<string>('lens.path', 'lens'),
          editor: this.config<string>('lens.bar.editor', ''),
          root: this.app.basePath(),
          stored: this.config<boolean>('lens.enabled', false),
          watchers: this.config<WatcherConfig>('lens.watchers', {})
        })
      )
    }

    this.use(
      lensPlugin(this.app, {
        onlyPaths: this.config<string[]>('lens.onlyPaths', []),
        ignorePaths: this.config<string[]>('lens.ignorePaths', []),
        requestWatcher: watchers.find(
          (watcher): watcher is RequestWatcher => watcher instanceof RequestWatcher
        ),
        ring: this.bar.on ? this.app.make('lens.ring') : undefined,
        baselines: this.bar.on ? this.app.make('lens.baselines') : undefined,
        profiler: this.bar.on ? this.app.make('lens.profiler') : undefined
      })
    )
  }

  /** The two things held in memory but owned elsewhere: the pause, and the tags. */
  private async refreshState(): Promise<void> {
    const lens = this.app.make('lens')

    await refreshPause(this.app, lens)
    await refreshMonitoring(this.app, lens)
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
    /**
     * Bar-only: nothing is written, and nothing complains about it.
     *
     * See `NullEntriesRepository`. The recorder still ends each unit of work by
     * handing its batch to storage, and the database driver would answer "no
     * such table" for an application that was never asked to migrate.
     *
     * Only when the bar is what turned recording on. With everything off the
     * real driver is still bound, because `lens:status` and `lens:prune` run in
     * a console where `lens.enabled` is read from the same config and would
     * otherwise be told by a no-op repository that the tables are empty.
     */
    if (!this.config<boolean>('lens.enabled', false) && this.bar.on) {
      this.app.singleton('lens.entries', () => new NullEntriesRepository())

      return
    }

    const driver = this.config<string>('lens.driver', 'database')

    if (driver !== 'database') {
      throw new Error(`[lens] Unsupported storage driver [${driver}]. Only [database] exists.`)
    }

    this.app.singleton('lens.entries', (app) => {
      return new DatabaseEntriesRepository(app.make('db'), {
        connection: this.config<string | undefined>('lens.storage.database.connection', undefined),
        table: 'lens_entries',
        chunk: this.app.config.integer('lens.storage.database.chunk', 1000)
      })
    })
  }
}
