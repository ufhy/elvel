import { rm } from 'node:fs/promises'
import { Command } from '../command.ts'

/**
 * `optimize` — everything a deploy should cache, in one command.
 *
 * Laravel caches routes, views, events and config here. Three of those four have
 * no counterpart and are not oversights:
 *
 * - **Routes** are Elysia instances holding closures. There is no serialisable
 *   form of a route table whose handlers are functions, and pretending otherwise
 *   would mean caching something that has to be rebuilt to be used.
 * - **Views** are TypeScript modules. Bun's own module cache is the compile
 *   cache, and there is no template language to compile ahead of time.
 * - **Events** are registered by running providers. There is no reflection to
 *   avoid, which is what Laravel's event cache exists to skip.
 *
 * So this runs `config:cache` and reports what it did rather than printing four
 * lines of which three are theatre.
 *
 * It also runs `app:build`, which has no Laravel counterpart at all. PHP keeps
 * its compiled opcodes between requests; Bun re-transpiles every module in every
 * process, and on the auth kit that is 3761 ms of a 4005 ms boot. Bundling is
 * the cache PHP gets for free, and a deploy is exactly where to build it.
 */
export class OptimizeCommand extends Command {
  static override signature = 'optimize {--except= : Comma-separated steps to skip}'

  static override description = 'Cache what a production boot should not compute'

  async handle(): Promise<number> {
    const except = this.stringOption('except')
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean)

    const steps = ['config:cache', 'app:build'].filter((step) => !except.includes(step))

    for (const step of steps) {
      const code = await this.call(step)

      if (code !== 0) {
        this.error(`${step} failed. Stopping.`)

        return code
      }
    }

    this.output.tag('INFO', `Cached: ${steps.join(', ') || 'nothing'}.`)

    return 0
  }
}

/**
 * `optimize:clear` — undo it, plus the application cache.
 *
 * Included in a deploy's rollback and in "it is behaving as though my change did
 * not land", which is almost always a config cache from a previous build.
 */
export class OptimizeClearCommand extends Command {
  static override signature = 'optimize:clear {--except= : Comma-separated steps to skip}'

  static override description = 'Clear the caches that optimize wrote'

  async handle(): Promise<number> {
    const except = this.stringOption('except')
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean)

    // `cache:clear` only when there is a cache bound: an application with no
    // cache store should not be told a command it never had has failed.
    const steps = ['config:clear', ...(this.app.bound('cache') ? ['cache:clear'] : [])].filter(
      (step) => !except.includes(step)
    )

    // Not a step, because there is no `app:build:clear` to call and inventing one
    // would be a command nobody runs on its own.
    if (!except.includes('app:build')) {
      await rm(this.app.basePath('dist'), { recursive: true, force: true })
    }

    let failed = 0

    for (const step of steps) {
      // Kept going rather than stopped at the first failure: this is the command
      // somebody runs when things are already wrong, and clearing three of four
      // caches beats clearing none.
      if ((await this.call(step)) !== 0) {
        this.error(`${step} failed.`)
        failed += 1
      }
    }

    this.output.tag('INFO', `Cleared: ${[...steps, 'dist/'].join(', ')}.`)

    return failed > 0 ? 1 : 0
  }
}
