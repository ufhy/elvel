import { Command } from '@elvel/console'
import { pauseKey } from './queue-pause.ts'
import { RESTART_KEY } from './queue-restart.ts'

/**
 * `queue:work`
 *
 * Runs until told otherwise. `--once` processes a single job, which is what a
 * test or a cron-driven deployment wants; `--stop-when-empty` drains the queue
 * and exits, which is what a container job wants.
 */
export class QueueWorkCommand extends Command {
  static override signature =
    'queue:work {connection? : The connection to work} {--queue= : Queue names, comma separated, in priority order} {--once : Process a single job and exit} {--stop-when-empty : Exit once the queue is empty} {--tries=1 : Attempts before a job is marked failed} {--backoff=0 : Seconds before a retry} {--timeout=60 : Seconds one attempt may run} {--sleep=3 : Seconds to wait when the queue is empty} {--max-jobs=0 : Exit after this many jobs} {--max-time=0 : Exit after this many seconds}'

  static override description = 'Process jobs on the queue'

  async handle(): Promise<number> {
    const connection = this.argument('connection') || undefined
    const manager = this.app.make('queue')
    const worker = manager.worker(connection)

    const queue = this.stringOption('queue') || undefined
    const options = {
      maxTries: Number(this.stringOption('tries') || 1),
      backoff: Number(this.stringOption('backoff') || 0),
      timeout: Number(this.stringOption('timeout') || 60),
      sleep: Number(this.stringOption('sleep') || 3),
      maxJobs: Number(this.stringOption('max-jobs') || 0),
      maxTime: Number(this.stringOption('max-time') || 0),
      stopWhenEmpty: this.flag('stop-when-empty'),

      /**
       * Where the restart signal lives, when there is a cache to hold it.
       *
       * Without one a worker simply never restarts on signal — `queue:restart`
       * says as much rather than pretending it broadcast something.
       */
      restartSignal: this.app.bound('cache')
        ? async () => (await this.app.make('cache').store().get<number>(RESTART_KEY)) ?? undefined
        : undefined,

      // Same store, same reason: without a cache there is nowhere to write a
      // pause, and `queue:pause` says so rather than pretending it took.
      pausedSignal: this.app.bound('cache')
        ? async (name: string) =>
            (await this.app.make('cache').store().get<boolean>(pauseKey(name))) === true
        : undefined
    }

    if (this.flag('once')) {
      const outcome = await worker.runNextJob(queue, options)

      this.output.tag('INFO', outcome === 'none' ? 'No job was waiting.' : `Job ${outcome}.`)

      return 0
    }

    // A worker asked to stop should finish the job in hand rather than abandon
    // it half-done, which is why this sets a flag instead of exiting.
    const stop = () => {
      this.comment('Finishing the current job, then stopping…')
      worker.stop()
    }

    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    this.info(
      `Working ${connection ?? manager.defaultConnection()} [${queue ?? manager.connection(connection).defaultQueue}]`
    )

    const result = await worker.work(queue, options)

    this.output.tag(
      'INFO',
      `Processed ${result.processed} job(s): ${result.failed} failed, ${result.released} released (${result.reason}).`
    )

    return 0
  }
}
