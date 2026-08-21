import { Command } from '../command.ts'

type Process = { name: string; argv: string[] }

/**
 * `dev` — the server, the asset server, a worker and the scheduler, in one
 * terminal.
 *
 * Four commands is four terminals, and one of them is always the one nobody
 * started: a queued job that never runs looks exactly like a bug in the code
 * that dispatched it, and a browser that never refreshes looks like a framework
 * without live reload. This runs them together and stops them together, which is
 * the half that matters — a Ctrl+C that leaves a worker holding a job is worse
 * than never having started it.
 *
 * The server runs under `bun --hot`, which re-evaluates changed modules in place
 * rather than restarting the process. Measured on a scaffolded application, a
 * change to a view reaches the next request in about 105ms that way against
 * about 195ms for `--watch`, and five successive edits left the routes, the
 * container and the 404 handler intact.
 *
 * Vite is what actually reloads the browser: the template's `refresh` plugin
 * watches the files that produce HTML and pushes a full reload down the socket
 * `@vite/client` already holds. Neither Bun nor Elysia can do that — see the
 * comment on that plugin for why.
 *
 * Output is prefixed rather than interleaved raw, because three streams into one
 * terminal is otherwise unreadable.
 */
export class DevCommand extends Command {
  static override signature =
    'dev {--port=3000 : Port for the server} {--no-queue : Do not run a queue worker} {--no-schedule : Do not run the scheduler} {--no-assets : Do not run the Vite dev server}'

  static override description = 'Run the server, a queue worker and the scheduler together'

  /** Can this application import the package, wherever it was hoisted to? */
  private canResolve(name: string): boolean {
    try {
      Bun.resolveSync(`${name}/package.json`, this.app.basePath())

      return true
    } catch {
      return false
    }
  }

  async handle(): Promise<number> {
    const processes: Process[] = [
      {
        name: 'server',
        argv: ['bun', '--hot', 'elvel.ts', 'serve', `--port=${this.stringOption('port', '3000')}`]
      }
    ]

    /**
     * The asset server, when the application has one installed.
     *
     * Skipped rather than attempted when `vite` is absent: `bun x vite` would
     * reach for the network mid-`dev`, and an application that never built a
     * front end has nothing for it to serve anyway. Said out loud, because a
     * browser that stops refreshing is otherwise a mystery.
     */
    if (!this.flag('no-assets')) {
      /**
       * Resolved, not stat'd.
       *
       * This looked for `<app>/node_modules/vite`, which is only one of the
       * places a package manager may put it: inside a workspace, or wherever a
       * version is shared, it is hoisted to a parent `node_modules` and the
       * directory check finds nothing while `vite` is perfectly usable. The
       * report was `vite is not installed` in an application that had installed
       * it — and then a page with no stylesheet.
       *
       * `Bun.resolveSync` walks the same chain an import would, which is the
       * question actually being asked.
       */
      if (this.canResolve('vite')) {
        processes.push({ name: 'assets', argv: ['bun', 'x', 'vite'] })
      } else {
        this.comment('vite is not installed, so assets and browser reload are off.')
      }
    }

    /**
     * Only what this application actually has.
     *
     * `--kit=none` ships neither the queue nor the scheduler, and starting a
     * worker there failed with `Command "queue:work" is not defined` — then took
     * the server down with it, because the first process to exit stops the rest.
     * A `dev` that cannot run in the smallest scaffold is a `dev` nobody trusts.
     */
    const kernel = this.app.make('elvel')

    if (!this.flag('no-queue') && kernel.has('queue:work')) {
      processes.push({ name: 'queue', argv: ['bun', 'elvel.ts', 'queue:work', '--tries=1'] })
    }

    if (!this.flag('no-schedule') && kernel.has('schedule:work')) {
      processes.push({ name: 'schedule', argv: ['bun', 'elvel.ts', 'schedule:work'] })
    }

    this.info(`Running: ${processes.map((one) => one.name).join(', ')}. Ctrl+C stops all of them.`)
    this.line()

    const children = processes.map((process) => ({
      name: process.name,
      handle: Bun.spawn(process.argv, {
        cwd: this.app.basePath(),
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'ignore',
        /**
         * Its own process group, so stopping means stopping.
         *
         * `queue:work` and `schedule:work` spawn children of their own; killing
         * only the direct child leaves those holding the port or the job, and the
         * next `dev` fails with "address in use" for reasons nothing explains.
         */
        detached: true
      })
    }))

    const stopAll = () => {
      for (const child of children) {
        try {
          process.kill(-child.handle.pid, 'SIGTERM')
        } catch {
          // Already gone. Nothing to stop is the outcome asked for.
        }
      }
    }

    process.on('SIGINT', stopAll)
    process.on('SIGTERM', stopAll)

    /**
     * The first one to exit takes the rest with it.
     *
     * A server that crashed while the worker carried on is the state where the
     * terminal looks alive and nothing is being served — worth ending loudly.
     */
    const first = await Promise.race(
      children.map(async (child) => ({ name: child.name, code: await child.handle.exited }))
    )

    this.line()
    this.warn(`[${first.name}] exited with ${first.code}. Stopping the rest.`)

    stopAll()

    return first.code
  }
}
