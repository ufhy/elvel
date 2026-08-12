import type { ScheduledEvent } from './event.ts'

/** The cache surface the mutexes need. Satisfied by `@elysian/cache`. */
export type MutexStore = {
  add(key: string, value: unknown, ttl?: number | Date | null): Promise<boolean>
  forget(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
}

export type RunnerEvents = { dispatch(event: string, payload?: unknown): unknown }

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
}

export type EventOutcome = 'ran' | 'skipped' | 'overlapping' | 'failed'

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
  constructor(private readonly options: RunnerOptions = {}) {}

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

      if (outcome === 'ran') result.ran += 1
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

        if (outcome === 'ran') result.ran += 1
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

    try {
      await event.callBefore()
      await event.callback()

      event.error = undefined

      await event.callOnSuccess()

      this.options.events?.dispatch('schedule.task.finished', { event: event.label })

      return 'ran'
    } catch (error) {
      event.error = error

      this.options.report?.(error)
      this.options.events?.dispatch('schedule.task.failed', { event: event.label, error })

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
