import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ServiceProvider } from '@elysian/core'
import { MakeJobCommand } from './console/make-job.ts'
import { QueueClearCommand } from './console/queue-clear.ts'
import { QueueFailedCommand } from './console/queue-failed.ts'
import { QueueFlushCommand } from './console/queue-flush.ts'
import { QueueForgetCommand } from './console/queue-forget.ts'
import { QueueRetryCommand } from './console/queue-retry.ts'
import { QueueSizeCommand } from './console/queue-size.ts'
import { QueueFailedTableCommand, QueueTableCommand } from './console/queue-table.ts'
import { QueueWorkCommand } from './console/queue-work.ts'
import type { JobClass } from './job.ts'
import { QueueManager } from './manager.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    queue: QueueManager
  }
}

/**
 * Binds the queue manager and discovers the jobs a worker can resolve.
 *
 * Discovery matters more here than for listeners: the worker is a different
 * process from whatever dispatched the job, so the payload carries a name and
 * nothing else. A name that resolves to no class is the one failure mode this
 * package cannot recover from, which is why the registry is filled at boot rather
 * than lazily.
 */
export class QueueServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('queue', (app) => new QueueManager(app))
  }

  override async boot(): Promise<void> {
    if (this.app.bound('artisan')) {
      this.app
        .make('artisan')
        .register(
          QueueWorkCommand,
          QueueFailedCommand,
          QueueRetryCommand,
          QueueForgetCommand,
          QueueFlushCommand,
          QueueClearCommand,
          QueueSizeCommand,
          QueueTableCommand,
          QueueFailedTableCommand,
          MakeJobCommand
        )
    }

    const manager = this.app.make('queue')

    manager.jobs.register(...(await this.discoverJobs()))
  }

  /** Every exported class in `app/Jobs` with a `handle` method. */
  private async discoverJobs(): Promise<JobClass[]> {
    const directory = this.app.appPath('Jobs')

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      return []
    }

    const jobs: JobClass[] = []

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>

      for (const exported of Object.values(module)) {
        if (!QueueServiceProvider.looksLikeJob(exported)) continue

        jobs.push(exported as JobClass)
      }
    }

    return jobs
  }

  private static looksLikeJob(value: unknown): boolean {
    return (
      typeof value === 'function' &&
      typeof (value as { prototype?: { handle?: unknown } }).prototype?.handle === 'function'
    )
  }
}
