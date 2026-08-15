import { Command } from '@elysian/console'

/** The cache key a paused queue is marked with. */
export const pauseKey = (queue: string) => `elysian:queue:paused:${queue}`

/**
 * `queue:pause` — stop reserving work without stopping the workers.
 *
 * For the twenty minutes a downstream service is broken. Killing the workers
 * instead loses whatever they were holding; letting them run burns every job's
 * attempts against a failure that has nothing to do with the job. Paused, they
 * stay alive and reserve nothing, and the queue simply grows until it is let go.
 */
export class QueuePauseCommand extends Command {
  static override signature = 'queue:pause {queue? : The queue to pause, or the default}'

  static override description = 'Stop workers reserving jobs from a queue'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('queue:pause needs a cache store — that is where the flag lives.')

      return 1
    }

    const queue = this.argument('queue') || this.app.make('queue').connection().defaultQueue

    // Forever: a pause that expired on its own would resume the queue at a time
    // nobody chose, which is the opposite of what was asked for.
    await this.app.make('cache').store().forever(pauseKey(queue), true)

    this.output.tag('INFO', `Queue [${queue}] paused. Workers stay up and reserve nothing.`)
    this.comment(`  Let it go again with: artisan queue:resume ${queue}`)

    return 0
  }
}

/** `queue:resume` — the other half. */
export class QueueResumeCommand extends Command {
  static override signature = 'queue:resume {queue? : The queue to resume, or the default}'

  static override description = 'Let workers reserve jobs from a paused queue again'

  async handle(): Promise<number> {
    if (!this.app.bound('cache')) {
      this.error('queue:resume needs a cache store — that is where the flag lives.')

      return 1
    }

    const queue = this.argument('queue') || this.app.make('queue').connection().defaultQueue

    await this.app.make('cache').store().forget(pauseKey(queue))

    this.output.tag('INFO', `Queue [${queue}] resumed.`)

    return 0
  }
}
