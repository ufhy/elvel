import { rmSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { Command } from '../command.ts'

type Process = { name: string; argv: string[] }

/**
 * The lines `dev` prints before anything else does.
 *
 * Separated from the command so the content can be tested without spawning four
 * processes. The complaint that produced it was concrete: `bun run dev` said
 * `Running: server, assets, schedule` and nothing about the port, the
 * environment, or where the assets were — all of which it knew.
 */
export function devSummary(input: {
  name: string
  environment: string
  port: string
  assets: string
}): string[] {
  return [
    `  Application:  ${input.name} (${input.environment})`,
    `  Server:       ${pc.underline(`http://localhost:${input.port}`)}`,
    `  Assets:       ${input.assets}`
  ]
}

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
 * The three streams are inherited, not piped, so they interleave raw. Piping them
 * to add a `[server]` prefix would take the terminal away from the children —
 * Vite and `serve` both check for one and drop their colours without it — so the
 * prefix is not worth what it costs. What makes the output readable instead is
 * that this command says everything a developer needs *before* the children start
 * talking.
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

  /**
   * Report the asset server's real origin, once it has one.
   *
   * Vite's port is not knowable in advance: it takes 5174 when 5173 is busy, and
   * printing 5173 anyway would be a guess that is wrong exactly when it matters.
   * The template's plugin writes the origin it actually bound to into
   * `public/hot`, so this waits for that file and prints what it says.
   *
   * `since` guards against a stale file — the plugin removes it on exit, but a
   * killed terminal can leave one behind, and reporting yesterday's port is worse
   * than reporting none.
   */
  private async announceAssets(since: number): Promise<void> {
    const path = join(this.app.basePath(), 'public', 'hot')
    const deadline = Date.now() + 20_000

    while (Date.now() < deadline) {
      const file = Bun.file(path)

      if ((await file.exists()) && file.lastModified >= since) {
        const origin = (await file.text()).trim()

        if (origin !== '') {
          this.comment(`  Assets:       ${pc.underline(origin)}`)
          this.line()
        }

        return
      }

      await Bun.sleep(200)
    }
  }

  async handle(): Promise<number> {
    const windows = process.platform === 'win32'
    const port = this.stringOption('port', '3000')

    const processes: Process[] = [
      {
        name: 'server',
        argv: ['bun', '--hot', 'elvel.ts', 'serve', `--port=${port}`]
      }
    ]

    /** What to print beside "Assets", decided as the process list is built. */
    let assets = 'off, because --no-assets was passed'

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
        assets = 'starting, its port is reported below'
      } else {
        assets = 'vite is not installed, so there is no browser reload'
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

    /**
     * Say what is running and where, before the processes start talking.
     *
     * `serve` prints its own banner — port, environment, route count — but it
     * prints it *as a child*, into a terminal three processes share. Under
     * `bun --hot` inside a repository with linked packages that banner arrived
     * after 229 lines of `warn: … will not be watched`, and the answer to "what
     * port is it on" was somewhere in the scrollback. This is the same
     * information, said first, by the command that was actually typed.
     */
    this.line()
    this.output.tag('INFO', `Running ${processes.map((one) => one.name).join(', ')}`)
    for (const line of devSummary({
      name: this.app.config.get('app.name', 'Elvel'),
      environment: this.app.environment(),
      port,
      assets
    })) {
      this.comment(line)
    }
    this.line()
    this.comment('  Ctrl+C stops all of them.')
    this.line()

    /**
     * Clear a hot file the last run could not clear itself.
     *
     * Vite's plugin removes it when it stops, but only if it gets to run its
     * handlers: a forced kill skips them and the file survives — measured on
     * Windows, both `taskkill /t /f` and `taskkill /t` left it behind. Until Vite
     * writes a new one, every page rendered by the server points its scripts at a
     * dev server that is not running.
     *
     * Removed here rather than trusted, because `dev` is about to start the
     * process that owns it.
     */
    if (processes.some((one) => one.name === 'assets')) {
      rmSync(join(this.app.basePath(), 'public', 'hot'), { force: true })
    }

    const startedAt = Date.now()

    const children = processes.map((process) => ({
      name: process.name,
      handle: Bun.spawn(process.argv, {
        cwd: this.app.basePath(),
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'ignore',
        /**
         * A process group on POSIX; nothing on Windows, deliberately.
         *
         * `detached` there does two things and neither one helps. It asks Windows
         * for a new console — measured: `conhost` went from 11 processes to 12
         * with the flag and stayed at 10 without it, which is the extra terminal
         * window that appears when `bun run dev` starts and Vite reports itself
         * into it instead of here. And the group kill it was added for does not
         * exist: `process.kill(-pid)` answers `ESRCH: no such process`, so the
         * children it was meant to stop were surviving anyway.
         */
        detached: !windows
      })
    }))

    /**
     * Stop the children *and* their own children.
     *
     * `queue:work` and `schedule:work` spawn processes of their own; stopping only
     * the direct child leaves those holding the port or a job, and the next `dev`
     * fails with "address in use" for reasons nothing explains. On POSIX a
     * negative pid reaches the whole group. On Windows there is no such call —
     * measured, it throws `ESRCH` — and `taskkill /t` is the equivalent that does
     * walk the tree.
     */
    const stopAll = () => {
      for (const child of children) {
        try {
          if (windows) {
            Bun.spawnSync(['taskkill', '/pid', String(child.handle.pid), '/t', '/f'], {
              stdout: 'ignore',
              stderr: 'ignore'
            })
          } else {
            process.kill(-child.handle.pid, 'SIGTERM')
          }
        } catch {
          // Already gone. Nothing to stop is the outcome asked for.
        }
      }
    }

    process.on('SIGINT', stopAll)
    process.on('SIGTERM', stopAll)

    /**
     * Not awaited: the race below is what keeps this command alive.
     *
     * If Vite never comes up, this simply gives up after twenty seconds and says
     * nothing more — a missing line is better than a command that waits for a
     * process that is not coming.
     */
    if (processes.some((one) => one.name === 'assets')) void this.announceAssets(startedAt)

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
