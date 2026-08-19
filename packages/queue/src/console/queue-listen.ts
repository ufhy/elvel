import { Command } from '@elvel/console'

/**
 * `queue:listen` — a worker for development, one process per job.
 *
 * `queue:work` loads the application once and keeps it, which is what makes it
 * fast and what makes it wrong at a keyboard: code edited after it started is
 * not the code it runs. This spawns a fresh `queue:work --once` for every job,
 * so each one picks up whatever is on disk now.
 *
 * The cost is a full boot per job. That is the trade, it is only worth making in
 * development, and it is why both commands exist rather than one with a flag.
 */
export class QueueListenCommand extends Command {
  static override signature =
    'queue:listen {connection? : The connection to work} {--queue= : The queue to work} {--sleep=1 : Seconds to wait when nothing is waiting} {--timeout=60 : Seconds a single job may take} {--tries=1 : Attempts before a job is marked failed}'

  static override description = 'Listen to a queue, reloading the code for every job'

  async handle(): Promise<number> {
    const connection = this.argument('connection')
    const sleep = Math.max(0, Number(this.stringOption('sleep', '1')))
    const timeout = Math.max(1, Number(this.stringOption('timeout', '60')))

    const argv = ['bun', 'elvel.ts', 'queue:work']
    if (connection !== '') argv.push(connection)
    if (this.stringOption('queue') !== '') argv.push(`--queue=${this.stringOption('queue')}`)
    argv.push('--once', `--tries=${this.stringOption('tries', '1')}`)

    this.output.tag('INFO', 'Listening. Every job runs in a fresh process.')
    this.comment('  Use queue:work in production — this reboots the application per job.')

    for (;;) {
      const child = Bun.spawn(argv, {
        cwd: this.app.basePath(),
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'ignore'
      })

      /**
       * The timeout is enforced here rather than inside the worker.
       *
       * A job that hangs cannot time itself out — that is what hanging means.
       * Only the parent can, and killing the child is the only way to stop it.
       */
      const timer = setTimeout(() => {
        child.kill()
        this.warn(`A job exceeded ${timeout}s and its process was killed.`)
      }, timeout * 1000)

      const code = await child.exited
      clearTimeout(timer)

      // A non-zero exit that is not a kill means the application itself failed to
      // boot; looping on that would spin at full speed printing the same error.
      if (code !== 0 && code !== 143 && code !== 137) {
        this.error(`queue:work exited with ${code}. Stopping.`)

        return code
      }

      if (sleep > 0) await Bun.sleep(sleep * 1000)
    }
  }
}
