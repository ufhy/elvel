import type { ScheduledEvent } from './event.ts'

/** The cache surface the mutexes need. Satisfied by `@elyvel/cache`. */
export type MutexStore = {
  add(key: string, value: unknown, ttl?: number | Date | null): Promise<boolean>
  forget(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
}

export type RunnerEvents = { dispatch(event: string, payload?: unknown): unknown }

/**
 * Starts a console command in a child process.
 *
 * `capture` asks for the child's output to be collected rather than inherited;
 * the string comes back with the exit code so the runner can file it or mail it.
 */
export type Spawner = (
  command: { name: string; parameters: string[] },
  capture: boolean
) => Promise<{ code: number; output?: string }>

export type RunnerOptions = {
  /** Where the overlap and one-server mutexes live. */
  mutex?: MutexStore
  events?: RunnerEvents
  /** Called with anything an event threw, so it reaches the log. */
  report?: (error: unknown) => void
  /**
   * Is the application in maintenance mode?
   *
   * A callback, asked once per run rather than read at registration: `down` and
   * `up` happen between runs, and a schedule that decided at boot would keep
   * running through a deploy that took it down.
   */
  isDownForMaintenance?: () => boolean | Promise<boolean>
  /**
   * How to run an entry marked `runInBackground()`.
   *
   * Injected rather than built here: this file has no idea what a Bun process or
   * an artisan binary is, and a test needs to watch what was started without
   * starting anything.
   */
  spawn?: Spawner
  /** Sends a task's output. Supplied when a mailer is registered. */
  mail?: (to: string[], subject: string, body: string) => Promise<void>
  /** Writes captured output to a file. Injected so this file needs no fs. */
  writeOutput?: (path: string, contents: string, append: boolean) => Promise<void>
}

export type EventOutcome = 'ran' | 'skipped' | 'overlapping' | 'failed' | 'background'

export type RunResult = {
  ran: number
  skipped: number
  failed: number
  outcomes: Array<{ event: string; outcome: EventOutcome; durationMs: number }>
}

/**
 * Runs the entries a schedule says are due.
 *
 * Kept out of the command so it can be driven by a test, and so `schedule:work`
 * and `schedule:run` share one implementation of the parts that matter: the
 * mutexes, the hooks, and the sub-minute repeat.
 */
export class ScheduleRunner {
  /** Children still running. Awaited before a run is called finished. */
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly options: RunnerOptions = {}) {}

  /**
   * Wait for every background entry started so far.
   *
   * `schedule:run` must call this before exiting: a process that leaves while a
   * child is still going releases no mutex and fires no `onSuccess`, so the next
   * minute finds the task apparently still running and skips it — for as long as
   * the mutex lives.
   */
  async waitForBackground(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running])
    }
  }

  /** How many children are still going. For `schedule:work` and for tests. */
  get backgroundCount(): number {
    return this.running.size
  }

  /**
   * Run every due event, in order.
   *
   * A failure is reported and recorded, never rethrown: one broken entry must not
   * stop the rest of the schedule for that minute.
   */
  async run(events: ScheduledEvent[]): Promise<RunResult> {
    const result: RunResult = { ran: 0, skipped: 0, failed: 0, outcomes: [] }

    // Asked once for the whole run: sixty tasks should not stat the same file
    // sixty times, and a `down` landing mid-run belongs to the next minute.
    const down = (await this.options.isDownForMaintenance?.()) === true

    for (const event of events) {
      if (down && !event.runsInMaintenance) {
        this.options.events?.dispatch('schedule.task.skipped', {
          event: event.label,
          reason: 'maintenance mode'
        })

        result.skipped += 1
        result.outcomes.push({ event: event.label, outcome: 'skipped', durationMs: 0 })

        continue
      }

      const started = Date.now()
      const outcome = await this.runEvent(event)

      // A started child counts as ran: whether it *succeeds* is settled later,
      // and calling it skipped would read as "did not run" in `schedule:run`.
      if (outcome === 'ran' || outcome === 'background') result.ran += 1
      else if (outcome === 'failed') result.failed += 1
      else result.skipped += 1

      result.outcomes.push({
        event: event.label,
        outcome,
        durationMs: Date.now() - started
      })
    }

    return result
  }

  /**
   * Repeat the sub-minute events until the minute `startedAt` belongs to is over.
   *
   * This is how `everyTenSeconds()` works: the expression still fires once a
   * minute, and the runner keeps coming back inside it.
   */
  async repeat(
    events: ScheduledEvent[],
    startedAt = new Date(),
    /**
     * When to stop. Defaults to the end of the minute `startedAt` belongs to,
     * which is what `schedule:run` wants; a caller that has to stop earlier — a
     * test, or a worker being shut down — can say so.
     */
    until?: Date
  ): Promise<RunResult> {
    const repeatable = events.filter((event) => event.isRepeatable)
    const result: RunResult = { ran: 0, skipped: 0, failed: 0, outcomes: [] }

    if (repeatable.length === 0) return result

    const endOfMinute = until ?? new Date(startedAt.getTime())
    if (!until) endOfMinute.setSeconds(59, 999)

    const lastRunAt = new Map<ScheduledEvent, number>()
    for (const event of repeatable) lastRunAt.set(event, startedAt.getTime())

    while (Date.now() <= endOfMinute.getTime()) {
      for (const event of repeatable) {
        const interval = (event.repeatInterval ?? 0) * 1000
        const since = Date.now() - (lastRunAt.get(event) ?? 0)

        if (since < interval) continue

        lastRunAt.set(event, Date.now())

        const started = Date.now()
        const outcome = await this.runEvent(event)

        if (outcome === 'ran' || outcome === 'background') result.ran += 1
        else if (outcome === 'failed') result.failed += 1
        else result.skipped += 1

        result.outcomes.push({ event: event.label, outcome, durationMs: Date.now() - started })
      }

      // A short sleep rather than a spin: the resolution needed is a second.
      await Bun.sleep(200)
    }

    return result
  }

  /** Filters, mutexes, hooks, then the callback. */
  async runEvent(event: ScheduledEvent): Promise<EventOutcome> {
    if (!(await event.filtersPass())) {
      this.options.events?.dispatch('schedule.task.skipped', { event: event.label })

      return 'skipped'
    }

    // One server out of several: whoever takes the mutex runs it, and the others
    // move on rather than waiting.
    if (event.runsOnOneServer && !(await this.takeMutex(event, 'one-server'))) {
      this.options.events?.dispatch('schedule.task.skipped', {
        event: event.label,
        reason: 'another server'
      })

      return 'skipped'
    }

    if (event.preventsOverlapping && !(await this.takeMutex(event, 'overlap'))) {
      this.options.events?.dispatch('schedule.task.overlapping', { event: event.label })

      return 'overlapping'
    }

    this.options.events?.dispatch('schedule.task.starting', { event: event.label })

    /**
     * A background entry returns as soon as the child is started.
     *
     * That is the whole point — the entries behind it do not wait — so the hooks
     * and the mutex are handled by the promise instead, and the run as a whole
     * waits for it at the end.
     */
    if (event.runsInBackground && event.forkable && this.options.spawn) {
      this.startInBackground(event, event.forkable)

      return 'background'
    }

    try {
      await event.callBefore()

      /**
       * Capturing in-process means patching `console`, which is intrusive enough
       * to do only when something asked for the output. A forked entry pipes its
       * child instead — see `startInBackground`.
       */
      if (event.capturesOutput) {
        const captured = await captureConsole(() => event.callback())

        // Assigned before the throw is re-raised: the output of a run that
        // failed is the output most worth keeping, and the catch below files it.
        event.output = captured.output

        if (captured.error) throw captured.error

        await this.deliverOutput(event, true)
      } else {
        event.output = undefined

        await event.callback()
      }

      event.error = undefined

      await event.callOnSuccess()

      this.options.events?.dispatch('schedule.task.finished', { event: event.label })

      return 'ran'
    } catch (error) {
      event.error = error

      this.options.report?.(error)
      this.options.events?.dispatch('schedule.task.failed', { event: event.label, error })

      if (event.capturesOutput) {
        // The output of a run that failed is the output most worth keeping, so
        // it is filed on this path too — and a failing delivery must not replace
        // the error that got us here.
        try {
          await this.deliverOutput(event, false)
        } catch (deliveryError) {
          this.options.report?.(deliveryError)
        }
      }

      // A failing hook must not hide the failure it was told about.
      try {
        await event.callOnFailure()
      } catch (hookError) {
        this.options.report?.(hookError)
      }

      return 'failed'
    } finally {
      try {
        await event.callAfter()
      } catch (hookError) {
        this.options.report?.(hookError)
      }

      // The overlap mutex is released as soon as the run is over; the one-server
      // mutex is not, because it has to keep the other servers out for the rest
      // of the minute.
      if (event.preventsOverlapping) await this.releaseMutex(event, 'overlap')
    }
  }

  /**
   * Start the child and arrange everything that has to happen when it ends.
   *
   * Nothing here is awaited by the caller. The promise is kept so the run can
   * wait for it at the end, and it never rejects: a background failure is the
   * event's failure, not the scheduler's, and a rejection nobody is awaiting yet
   * would be an unhandled one.
   */
  private startInBackground(
    event: ScheduledEvent,
    command: { name: string; parameters: string[] }
  ): void {
    const finished = (async () => {
      try {
        await event.callBefore()

        const { code, output } = await (this.options.spawn as Spawner)(
          command,
          event.capturesOutput
        )

        event.output = output

        if (event.capturesOutput) await this.deliverOutput(event, code === 0)

        if (code === 0) {
          event.error = undefined
          await event.callOnSuccess()
          this.options.events?.dispatch('schedule.task.finished', { event: event.label })
        } else {
          // An exit code is all a child can tell us, so it becomes the error the
          // failure hooks see — the same shape a foreground command produces.
          const error = new Error(`Scheduled command [${event.label}] exited with code ${code}.`)

          event.error = error
          this.options.report?.(error)
          this.options.events?.dispatch('schedule.task.failed', { event: event.label, error })

          await event.callOnFailure()
        }
      } catch (error) {
        event.error = error
        this.options.report?.(error)
        this.options.events?.dispatch('schedule.task.failed', { event: event.label, error })
      } finally {
        try {
          await event.callAfter()
        } catch (hookError) {
          this.options.report?.(hookError)
        }

        if (event.preventsOverlapping) await this.releaseMutex(event, 'overlap')
      }
    })()

    const tracked = finished.finally(() => {
      this.running.delete(tracked)
    })

    this.running.add(tracked)
  }

  /**
   * File and mail whatever the task printed.
   *
   * Both are best-effort in the sense that neither turns a successful task into
   * a failed one — but a failure to deliver is reported, because output that
   * silently never arrives is worse than none: it is a report somebody believes
   * they are receiving.
   */
  private async deliverOutput(event: ScheduledEvent, succeeded: boolean): Promise<void> {
    const output = event.output ?? ''

    if (event.outputPath && this.options.writeOutput) {
      await this.options.writeOutput(event.outputPath, output, event.outputAppends)
    }

    if (event.emailTo.length === 0) return
    if (event.emailOnFailureOnly && succeeded) return
    if (event.emailOnlyWithOutput && output.trim() === '') return

    if (!this.options.mail) {
      this.options.report?.(
        new Error(
          `[${event.label}] asks for its output to be emailed, but no mailer is registered. Register MailServiceProvider.`
        )
      )

      return
    }

    const state = succeeded ? 'output' : 'FAILED'

    await this.options.mail(
      event.emailTo,
      `Scheduled task ${state}: ${event.label}`,
      output === '' ? '(no output)' : output
    )
  }

  private async takeMutex(event: ScheduledEvent, kind: string): Promise<boolean> {
    if (!this.options.mutex) {
      throw new Error(
        'withoutOverlapping() and onOneServer() need a cache store. Register CacheServiceProvider.'
      )
    }

    // `add` is write-if-absent, which is the atomic part; the value is only there
    // to make the entry readable while debugging.
    return this.options.mutex.add(
      `${event.mutexName()}:${kind}`,
      new Date().toISOString(),
      kind === 'one-server' ? 60 : event.mutexMinutes * 60
    )
  }

  private async releaseMutex(event: ScheduledEvent, kind: string): Promise<void> {
    await this.options.mutex?.forget(`${event.mutexName()}:${kind}`)
  }
}

/**
 * Run `body` with `console` collected.
 *
 * Patching the global is the only way to capture what an in-process command
 * prints — it writes through `console`, not through a stream this code owns.
 * Restored in a `finally`, so a throwing task cannot leave the application
 * silent.
 */
async function captureConsole(body: () => unknown): Promise<{ output: string; error?: unknown }> {
  const lines: string[] = []
  const original = { log: console.log, error: console.error, warn: console.warn }

  const collect = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(' '))
  }

  console.log = collect
  console.error = collect
  console.warn = collect

  let error: unknown

  try {
    await body()
  } catch (thrown) {
    // Caught rather than propagated, so the lines printed before the failure are
    // still returned; the caller re-raises it.
    error = thrown
  } finally {
    console.log = original.log
    console.error = original.error
    console.warn = original.warn
  }

  return error === undefined ? { output: lines.join('\n') } : { output: lines.join('\n'), error }
}
