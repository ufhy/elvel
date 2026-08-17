import type { ApplicationContract } from '@elyvel/contracts'
import { ProcessManager } from '@elyvel/process'
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
   * minute — see BEHAVIOURS.md.
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
        /**
         * Reached by name, because an application may not have the queue.
         *
         * `make('queue')` is typed by a declaration `@elyvel/queue` merges in,
         * and an application that does not register the queue provider never
         * loads that file — so the binding types as `unknown` and the
         * *application's* `tsc` fails inside this package. The cast says what is
         * true either way: this is a binding that may not be there, and calling
         * `schedule().job(…)` without it is a run-time error with a name, not a
         * compile-time one in somebody else's source.
         */
        await (
          this.app.make('queue' as never) as {
            dispatch(job: unknown, options: unknown): Promise<unknown>
          }
        ).dispatch(job, options)
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

    return this.add(
      new ScheduledEvent(async () => {
        // An array is passed straight to the program; only an explicit string
        // opts into a shell. `@elyvel/process` makes the same distinction, and
        // gives the command its own process group so a scheduled task that forks
        // does not leave children behind.
        const result = await new ProcessManager().path(this.app.basePath()).inherit().run(command)

        if (result.failed()) {
          throw new Error(`Scheduled command [${summary}] exited with code ${result.exitCode}.`)
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
  /**
   * Apply the same settings to several tasks — Laravel's `group()`.
   *
   * ```ts
   * schedule.group((event) => event.onOneServer().withoutOverlapping(), (s) => {
   *   s.command('reports:daily').dailyAt('2:00')
   *   s.command('reports:weekly').weeklyOn(1, '3:00')
   * })
   * ```
   *
   * Everything defined inside the callback is configured by `settings`, which is
   * applied *after* the definition — so a task that set something of its own
   * inside the block does not have it silently reverted... unless the group sets
   * the same thing, which is what a group is for.
   */
  group(settings: (event: ScheduledEvent) => unknown, define: (schedule: this) => void): this {
    const before = this.entries.length

    define(this)

    for (const event of this.entries.slice(before)) settings(event)

    return this
  }

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
