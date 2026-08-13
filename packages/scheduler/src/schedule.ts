import type { ApplicationContract } from '@elysian/contracts'
import { type EventCallback, ScheduledEvent } from './event.ts'

/** A job, structurally — the queue package satisfies this. */
type Dispatchable = { constructor: { name: string } }

/**
 * The schedule — `Illuminate\Console\Scheduling\Schedule`.
 *
 * Four ways in, and they all produce the same kind of entry: a callback with a
 * cron expression. An artisan command becomes a callback that runs the command, a
 * queued job becomes one that dispatches it. That is what keeps `schedule:run`
 * simple enough to trust.
 */
export class Schedule {
  private readonly entries: ScheduledEvent[] = []

  /** Zone applied to entries that do not set their own. */
  private defaultTimezone: string | undefined

  constructor(private readonly app: ApplicationContract) {}

  /** Run a callback. */
  call(callback: EventCallback, summary = 'Closure'): ScheduledEvent {
    return this.add(new ScheduledEvent(callback, summary))
  }

  /**
   * Run an artisan command.
   *
   * In this process, not a spawned one: there is no second runtime to start, and
   * the exit code comes back directly. The cost is that a slow command holds the
   * minute — see GAPS.
   */
  command(command: string, parameters: string[] = []): ScheduledEvent {
    const summary = [command, ...parameters].join(' ')

    const event = new ScheduledEvent(async () => {
      const code = await this.app.make('artisan').run([command, ...parameters])

      if (code !== 0) {
        throw new Error(`Scheduled command [${summary}] exited with code ${code}.`)
      }
    }, summary)

    // Remembered separately from the callback: a child process cannot be handed
    // a closure, so `runInBackground()` needs the command and its arguments.
    event.forkable = { name: command, parameters }

    return this.add(event)
  }

  /** Push a job onto a queue when the entry is due. */
  job(job: Dispatchable, options: { queue?: string; connection?: string } = {}): ScheduledEvent {
    const summary = job.constructor.name

    return this.add(
      new ScheduledEvent(async () => {
        await this.app.make('queue').dispatch(job as never, options)
      }, summary)
    )
  }

  /**
   * Run an external command.
   *
   * Prefer the array form — `exec(['pg_dump', database])` — which is executed
   * directly, with no shell to interpret metacharacters in an argument. The string
   * form goes through `sh -c`, which is what you want for pipes and redirection
   * and what you must not use with anything a request supplied: a value
   * containing `;` or a backtick would run as a command of its own.
   *
   * The exit code decides success. Output is inherited rather than captured;
   * capturing it is what `sendOutputTo` would be for, and that is not built.
   */
  exec(command: string | string[]): ScheduledEvent {
    const summary = Array.isArray(command) ? command.join(' ') : command

    // An array is passed straight to the program; only an explicit string opts
    // into a shell.
    const argv = Array.isArray(command) ? command : ['sh', '-c', command]

    return this.add(
      new ScheduledEvent(async () => {
        const spawned = Bun.spawn(argv, {
          cwd: this.app.basePath(),
          stdout: 'inherit',
          stderr: 'inherit'
        })

        const code = await spawned.exited

        if (code !== 0) {
          throw new Error(`Scheduled command [${summary}] exited with code ${code}.`)
        }
      }, summary)
    )
  }

  /** Apply a timezone to every entry that does not name one. */
  useTimezone(zone: string): this {
    this.defaultTimezone = zone

    return this
  }

  /** Everything registered, in the order it was registered. */
  events(): ScheduledEvent[] {
    return [...this.entries]
  }

  /** The entries whose expression and environment say they are due now. */
  dueEvents(at = new Date()): ScheduledEvent[] {
    const environment = this.app.environment()

    return this.entries.filter((event) => event.isDue(at, environment))
  }

  /** Forget everything. Used by tests and by a reloading dev server. */
  flush(): this {
    this.entries.length = 0

    return this
  }

  private add(event: ScheduledEvent): ScheduledEvent {
    if (this.defaultTimezone) event.timezone(this.defaultTimezone)

    this.entries.push(event)

    return event
  }
}
