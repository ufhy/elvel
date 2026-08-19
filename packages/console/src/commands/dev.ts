import { Command } from '../command.ts'

type Process = { name: string; argv: string[] }

/**
 * `dev` — the server, a worker and the scheduler, in one terminal.
 *
 * Three commands is three terminals, and the third one is always the one nobody
 * started: a queued job that never runs looks exactly like a bug in the code
 * that dispatched it. This runs them together and stops them together, which is
 * the half that matters — a Ctrl+C that leaves a worker holding a job is worse
 * than never having started it.
 *
 * Output is prefixed rather than interleaved raw, because three streams into one
 * terminal is otherwise unreadable.
 */
export class DevCommand extends Command {
  static override signature =
    'dev {--port=3000 : Port for the server} {--no-queue : Do not run a queue worker} {--no-schedule : Do not run the scheduler}'

  static override description = 'Run the server, a queue worker and the scheduler together'

  async handle(): Promise<number> {
    const processes: Process[] = [
      {
        name: 'server',
        argv: ['bun', 'elvel.ts', 'serve', `--port=${this.stringOption('port', '3000')}`]
      }
    ]

    if (!this.flag('no-queue')) {
      processes.push({ name: 'queue', argv: ['bun', 'elvel.ts', 'queue:work', '--tries=1'] })
    }

    if (!this.flag('no-schedule')) {
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
