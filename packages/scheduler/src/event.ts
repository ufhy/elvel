import { CronExpression, DAY_OF_MONTH, DAY_OF_WEEK, HOUR, MINUTE, MONTH, partsIn } from './cron.ts'

/** What a scheduled event does when it is due. */
export type EventCallback = () => Promise<unknown> | unknown

type Filter = () => Promise<boolean> | boolean

type Hook = (event: ScheduledEvent) => Promise<unknown> | unknown

/**
 * How a ping is sent. Replaceable, because a test must not reach the network.
 */
let pinger: (url: string) => Promise<unknown> = (url) => fetch(url, { method: 'GET' })

/** Swap the pinger — for tests, and for an application that needs headers. */
export function setPinger(send: (url: string) => Promise<unknown>): void {
  pinger = send
}

async function ping(url: string): Promise<void> {
  try {
    await pinger(url)
  } catch {
    // Deliberately silent. A monitoring endpoint being unreachable must not turn
    // a successful backup into a failed one, and the ping has no other caller to
    // report to.
  }
}

/**
 * One entry in the schedule — `Illuminate\Console\Scheduling\Event`.
 *
 * Every frequency helper writes into the same cron expression rather than into a
 * parallel notion of time. `dailyAt('13:30')` *is* `30 13 * * *`, which means one
 * matcher decides everything and `schedule:list` can show the expression a
 * sysadmin already knows how to read.
 */
export class ScheduledEvent {
  /** Runs every minute until a frequency says otherwise. */
  private expression = '* * * * *'

  private timezoneName: string | undefined

  private readonly filters: Filter[] = []
  private readonly rejects: Filter[] = []

  private environmentNames: string[] | undefined

  private overlapping = false
  private runsInMaintenanceMode = false
  /** Minutes the overlap mutex is held, as Laravel's `expiresAt` default. */
  private expiresAfter = 1440
  private oneServer = false

  private repeatSeconds: number | undefined

  private background = false

  /** Where the output goes, when it is captured at all. */
  outputPath: string | undefined
  outputAppends = false
  emailTo: string[] = []
  emailOnlyWithOutput = true
  /** Filled by the runner once the entry has run. */
  output: string | undefined

  /**
   * What to run in a child process, when this entry came from `command()`.
   *
   * Only a console command can be forked. A closure cannot: the child is a fresh
   * process, and there is nothing there to rebuild it from — the same wall a
   * queued closure hits. Laravel's `CallbackEvent` throws for the same reason.
   */
  forkable: { name: string; parameters: string[] } | undefined

  private descriptionText: string | undefined
  private nameText: string | undefined

  private readonly beforeHooks: Hook[] = []
  private readonly afterHooks: Hook[] = []
  private readonly successHooks: Hook[] = []
  private readonly failureHooks: Hook[] = []

  /** Set by the runner: the error of the last attempt, if it failed. */
  error: unknown

  constructor(
    readonly callback: EventCallback,
    /** What this entry is, for `schedule:list` and for the mutex name. */
    readonly summary: string
  ) {}

  // -------------------------------------------------------------- frequencies

  /** Set the expression outright. */
  cron(expression: string): this {
    this.expression = CronExpression.parse(expression).toString()

    return this
  }

  everyMinute(): this {
    return this.splice(MINUTE, '*')
  }

  everyTwoMinutes(): this {
    return this.splice(MINUTE, '*/2')
  }

  everyThreeMinutes(): this {
    return this.splice(MINUTE, '*/3')
  }

  everyFourMinutes(): this {
    return this.splice(MINUTE, '*/4')
  }

  everyFiveMinutes(): this {
    return this.splice(MINUTE, '*/5')
  }

  everyTenMinutes(): this {
    return this.splice(MINUTE, '*/10')
  }

  everyFifteenMinutes(): this {
    return this.splice(MINUTE, '*/15')
  }

  everyThirtyMinutes(): this {
    return this.splice(MINUTE, '0,30')
  }

  hourly(): this {
    return this.splice(MINUTE, 0)
  }

  /** On the hour, at these minutes past. */
  hourlyAt(offset: number | number[]): this {
    return this.hourBased(offset, '*')
  }

  everyTwoHours(offset: number | number[] = 0): this {
    return this.hourBased(offset, '*/2')
  }

  everyThreeHours(offset: number | number[] = 0): this {
    return this.hourBased(offset, '*/3')
  }

  everyFourHours(offset: number | number[] = 0): this {
    return this.hourBased(offset, '*/4')
  }

  everySixHours(offset: number | number[] = 0): this {
    return this.hourBased(offset, '*/6')
  }

  /**
   * At 1am, 3am, 5am … — the hours an every-two-hours schedule misses.
   *
   * Useful for exactly the reason it exists in Laravel: two jobs that must not
   * run in the same hour as each other, where one takes the even hours and the
   * other takes these.
   */
  everyOddHour(offset: number | number[] = 0): this {
    return this.hourBased(offset, '1-23/2')
  }

  daily(): this {
    return this.hourBased(0, 0)
  }

  /** Laravel's `at()`: the same thing as `dailyAt`, read aloud differently. */
  at(time: string): this {
    return this.dailyAt(time)
  }

  /** `dailyAt('13:30')`, or `dailyAt('13')` for the hour alone. */
  dailyAt(time: string): this {
    const [hour, minute] = time.split(':')

    return this.hourBased(minute === undefined ? 0 : Number(minute), Number(hour))
  }

  twiceDaily(first = 1, second = 13): this {
    return this.twiceDailyAt(first, second, 0)
  }

  twiceDailyAt(first = 1, second = 13, offset = 0): this {
    return this.hourBased(offset, `${first},${second}`)
  }

  weekdays(): this {
    return this.days([1, 2, 3, 4, 5])
  }

  weekends(): this {
    return this.days([0, 6])
  }

  mondays(): this {
    return this.days(1)
  }

  tuesdays(): this {
    return this.days(2)
  }

  wednesdays(): this {
    return this.days(3)
  }

  thursdays(): this {
    return this.days(4)
  }

  fridays(): this {
    return this.days(5)
  }

  saturdays(): this {
    return this.days(6)
  }

  sundays(): this {
    return this.days(0)
  }

  weekly(): this {
    return this.hourBased(0, 0).days(0)
  }

  weeklyOn(day: number | number[], time = '0:0'): this {
    return this.dailyAt(time).days(day)
  }

  monthly(): this {
    return this.hourBased(0, 0).splice(DAY_OF_MONTH, 1)
  }

  monthlyOn(dayOfMonth = 1, time = '0:0'): this {
    return this.dailyAt(time).splice(DAY_OF_MONTH, dayOfMonth)
  }

  twiceMonthly(first = 1, second = 16, time = '0:0'): this {
    return this.dailyAt(time).splice(DAY_OF_MONTH, `${first},${second}`)
  }

  daysOfMonth(...days: Array<number | number[]>): this {
    return this.dailyAt('0:0').splice(DAY_OF_MONTH, days.flat().join(','))
  }

  /**
   * The last day of the month, whatever length it is.
   *
   * `L` rather than the current month's length: Laravel splices in the number of
   * days in the month *at the time the schedule is defined*, which is wrong for a
   * long-running process that crosses into a shorter month.
   */
  lastDayOfMonth(time = '0:0'): this {
    return this.dailyAt(time).splice(DAY_OF_MONTH, 'L')
  }

  quarterly(): this {
    return this.hourBased(0, 0).splice(DAY_OF_MONTH, 1).splice(MONTH, '1-12/3')
  }

  /** A quarter, on a day and at a time of your own. */
  quarterlyOn(dayOfMonth = 1, time = '0:0'): this {
    return this.dailyAt(time).splice(DAY_OF_MONTH, dayOfMonth).splice(MONTH, '1-12/3')
  }

  yearly(): this {
    return this.hourBased(0, 0).splice(DAY_OF_MONTH, 1).splice(MONTH, 1)
  }

  yearlyOn(month = 1, dayOfMonth = 1, time = '0:0'): this {
    return this.dailyAt(time).splice(DAY_OF_MONTH, dayOfMonth).splice(MONTH, month)
  }

  /** Limit to these days of the week. `0` is Sunday. */
  days(days: number | number[] | string): this {
    const value = Array.isArray(days) ? days.join(',') : String(days)

    return this.splice(DAY_OF_WEEK, value)
  }

  /**
   * Repeat within the minute, every `seconds`.
   *
   * The expression still fires once a minute; the runner repeats the event inside
   * that minute, which is how Laravel reaches sub-minute frequencies without a
   * second scheduler.
   */
  everySecond(): this {
    return this.repeatEvery(1)
  }

  everyFiveSeconds(): this {
    return this.repeatEvery(5)
  }

  everyTenSeconds(): this {
    return this.repeatEvery(10)
  }

  everyTwoSeconds(): this {
    return this.repeatEvery(2)
  }

  everyFifteenSeconds(): this {
    return this.repeatEvery(15)
  }

  everyTwentySeconds(): this {
    return this.repeatEvery(20)
  }

  everyThirtySeconds(): this {
    return this.repeatEvery(30)
  }

  repeatEvery(seconds: number): this {
    if (seconds <= 0 || 60 % seconds !== 0) {
      throw new Error(`Repeat interval [${seconds}] must divide 60 evenly.`)
    }

    this.repeatSeconds = seconds

    return this.everyMinute()
  }

  // ------------------------------------------------------------------ filters

  /** Evaluate the expression in this zone. */
  timezone(zone: string): this {
    this.timezoneName = zone

    return this
  }

  /** Run only when the callback returns true. */
  when(filter: Filter | boolean): this {
    this.filters.push(typeof filter === 'function' ? filter : () => filter)

    return this
  }

  /**
   * Run this entry even while the application is in maintenance mode.
   *
   * Off by default, and that default is the useful one: maintenance mode usually
   * means something is being repaired or migrated, and a scheduled task that keeps
   * writing through it is how a half-finished migration acquires new rows. The
   * exceptions — a health ping, a queue drain, log rotation — say so.
   */
  evenInMaintenanceMode(): this {
    this.runsInMaintenanceMode = true

    return this
  }

  /** Read by the runner, which is what knows whether the application is down. */
  get runsInMaintenance(): boolean {
    return this.runsInMaintenanceMode
  }

  /** Skip when the callback returns true. */
  skip(filter: Filter | boolean): this {
    this.rejects.push(typeof filter === 'function' ? filter : () => filter)

    return this
  }

  /** Only between these local times, inclusive. */
  between(start: string, end: string): this {
    return this.when(() => this.inTimeInterval(start, end))
  }

  unlessBetween(start: string, end: string): this {
    return this.skip(() => this.inTimeInterval(start, end))
  }

  /** Only in these environments. */
  environments(...names: Array<string | string[]>): this {
    this.environmentNames = names.flat()

    return this
  }

  /**
   * Do not start a second run while one is still going.
   *
   * Needs a cache store with locks, which is where the mutex lives. `minutes` is
   * how long the lock survives a process that died holding it.
   */
  withoutOverlapping(minutes = 1440): this {
    this.overlapping = true
    this.expiresAfter = minutes

    return this
  }

  /** Run on one server only, when several share a schedule. */
  onOneServer(): this {
    this.oneServer = true

    return this
  }

  name(name: string): this {
    this.nameText = name

    return this
  }

  description(description: string): this {
    this.descriptionText = description

    return this
  }

  // -------------------------------------------------------------------- hooks

  before(hook: Hook): this {
    this.beforeHooks.push(hook)

    return this
  }

  /**
   * Runs after the task, whether it succeeded or not.
   *
   * Laravel spells this `then()` as well; that alias is deliberately absent here.
   * An object with a `then` method *is* a thenable, so `await schedule.call(…)`
   * would hand `resolve` to it as a hook — a chainable builder must never be
   * mistakable for a promise.
   */
  after(hook: Hook): this {
    this.afterHooks.push(hook)

    return this
  }

  onSuccess(hook: Hook): this {
    this.successHooks.push(hook)

    return this
  }

  onFailure(hook: Hook): this {
    this.failureHooks.push(hook)

    return this
  }

  // -------------------------------------------------------------------- pings

  /**
   * Call a URL before the task runs.
   *
   * This is how a scheduled task is monitored from outside: a service that
   * expects a request every hour and shouts when one does not arrive is the only
   * thing that can notice a schedule that stopped running altogether — no hook
   * inside a process that is not running can.
   *
   * A ping that fails is swallowed. The monitoring being down must not fail the
   * backup it was watching.
   */
  pingBefore(url: string): this {
    return this.before(() => ping(url))
  }

  /** As `pingBefore`, when `condition` holds. */
  pingBeforeIf(condition: boolean, url: string): this {
    return condition ? this.pingBefore(url) : this
  }

  /** Call a URL after the task, whether it succeeded or not. */
  thenPing(url: string): this {
    return this.after(() => ping(url))
  }

  /** As `thenPing`, when `condition` holds. */
  thenPingIf(condition: boolean, url: string): this {
    return condition ? this.thenPing(url) : this
  }

  /** Call a URL only when the task succeeded. */
  pingOnSuccess(url: string): this {
    return this.onSuccess(() => ping(url))
  }

  pingOnSuccessIf(condition: boolean, url: string): this {
    return condition ? this.pingOnSuccess(url) : this
  }

  /**
   * Call a URL only when the task failed.
   *
   * The failure URL is usually a different endpoint of the same monitor — the
   * distinction between "did not run" and "ran and broke" is one the service can
   * only draw if both are reported.
   */
  pingOnFailure(url: string): this {
    return this.onFailure(() => ping(url))
  }

  pingOnFailureIf(condition: boolean, url: string): this {
    return condition ? this.pingOnFailure(url) : this
  }

  // ------------------------------------------------------------------ reading

  /** Is this expression due in the minute `date` falls in? */
  isDue(date = new Date(), environment?: string): boolean {
    if (!this.runsInEnvironment(environment)) return false

    return CronExpression.parse(this.expression).matches(date, this.timezoneName)
  }

  /**
   * Do the `when`/`skip` filters allow it?
   *
   * Kept apart from `isDue` on purpose: an event whose filters refused is
   * *skipped*, and worth reporting as such, rather than never having been due.
   */
  async filtersPass(): Promise<boolean> {
    for (const filter of this.filters) {
      if (!(await filter())) return false
    }

    for (const reject of this.rejects) {
      if (await reject()) return false
    }

    return true
  }

  runsInEnvironment(environment?: string): boolean {
    if (!this.environmentNames || environment === undefined) return true

    return this.environmentNames.includes(environment)
  }

  nextRunAt(from = new Date()): Date {
    return CronExpression.parse(this.expression).nextRunAt(from, this.timezoneName)
  }

  /**
   * The mutex key, from the expression and what the event does.
   *
   * Hashed so two events with the same schedule and command share a lock across
   * processes and servers, which is exactly what `withoutOverlapping` and
   * `onOneServer` need.
   */
  mutexName(): string {
    const digest = new Bun.CryptoHasher('sha1')
      .update(`${this.expression}${this.summary}`)
      .digest('hex')

    return `elyvel:schedule:${digest}`
  }

  get cronExpression(): string {
    return this.expression
  }

  get zone(): string | undefined {
    return this.timezoneName
  }

  get preventsOverlapping(): boolean {
    return this.overlapping
  }

  get mutexMinutes(): number {
    return this.expiresAfter
  }

  get runsOnOneServer(): boolean {
    return this.oneServer
  }

  /**
   * Run this entry in a child process, so a slow task does not hold the minute.
   *
   * Everything in a schedule otherwise runs one after another in the scheduler's
   * own process: a task that takes two minutes delays every entry behind it, and
   * with a minute-by-minute cron that is a schedule quietly falling behind.
   *
   * The child is still waited on — by the run as a whole, not by the entries
   * after it — because the mutex has to be released and `onSuccess`/`onFailure`
   * have to see the exit code. Laravel achieves that by having the child call
   * `schedule:finish` when it is done; a long-lived process can simply hold the
   * promise, which is fewer moving parts and cannot be orphaned by a crash
   * between the two commands.
   */
  runInBackground(): this {
    if (!this.forkable) {
      throw new Error(
        `Only a scheduled command can run in the background; [${this.label}] is a closure, and a child process has nothing to rebuild it from. Dispatch a job instead: schedule().job(...) returns at once.`
      )
    }

    this.background = true

    return this
  }

  get runsInBackground(): boolean {
    return this.background
  }

  /**
   * Write what the task printed to a file.
   *
   * Without this the output is inherited: a background entry's logging lands
   * wherever the scheduler's does, interleaved with every other entry. A file
   * per task is what makes "what did the nightly import say last night?"
   * answerable at all.
   */
  sendOutputTo(path: string, append = false): this {
    this.outputPath = path
    this.outputAppends = append

    return this
  }

  /** The same, keeping what is already in the file. */
  appendOutputTo(path: string): this {
    return this.sendOutputTo(path, true)
  }

  /**
   * Mail the output once the task has run.
   *
   * `onlyIfOutputExists` defaults to true, and that default is the useful one: a
   * task that succeeds silently every night would otherwise send an empty mail
   * every night, and mail nobody reads is mail nobody notices when it matters.
   *
   * Capturing is turned on implicitly — asking for the output to be mailed and
   * getting nothing because it was never captured is a trap, not a feature.
   */
  emailOutputTo(addresses: string | string[], onlyIfOutputExists = true): this {
    this.emailTo = [...this.emailTo, ...(Array.isArray(addresses) ? addresses : [addresses])]
    this.emailOnlyWithOutput = onlyIfOutputExists

    return this
  }

  /** Mail the output only when the task fails. */
  emailOutputOnFailure(addresses: string | string[]): this {
    this.emailOnFailureOnly = true

    return this.emailOutputTo(addresses, false)
  }

  emailOnFailureOnly = false

  /** Is anything interested in what this task printed? */
  get capturesOutput(): boolean {
    return this.outputPath !== undefined || this.emailTo.length > 0
  }

  get repeatInterval(): number | undefined {
    return this.repeatSeconds
  }

  get isRepeatable(): boolean {
    return this.repeatSeconds !== undefined
  }

  get label(): string {
    return this.nameText ?? this.summary
  }

  get describedAs(): string | undefined {
    return this.descriptionText
  }

  /** Run the hooks a runner is responsible for. */
  async callBefore(): Promise<void> {
    for (const hook of this.beforeHooks) await hook(this)
  }

  async callAfter(): Promise<void> {
    for (const hook of this.afterHooks) await hook(this)
  }

  async callOnSuccess(): Promise<void> {
    for (const hook of this.successHooks) await hook(this)
  }

  async callOnFailure(): Promise<void> {
    for (const hook of this.failureHooks) await hook(this)
  }

  private hourBased(minutes: number | number[] | string, hours: number | string): this {
    const minute = Array.isArray(minutes) ? minutes.join(',') : String(minutes)

    return this.splice(MINUTE, minute).splice(HOUR, hours)
  }

  private splice(position: number, value: string | number): this {
    this.expression = CronExpression.parse(this.expression).spliceField(position, value).toString()

    return this
  }

  /**
   * Is the current local time inside `start`–`end`?
   *
   * A window that ends before it starts crosses midnight, and the comparison has
   * to say so rather than matching nothing.
   */
  private inTimeInterval(start: string, end: string): boolean {
    const parts = partsIn(new Date(), this.timezoneName)
    const now = parts.hour * 60 + parts.minute

    const from = ScheduledEvent.minutesOf(start)
    const to = ScheduledEvent.minutesOf(end)

    if (to < from) return now >= from || now <= to

    return now >= from && now <= to
  }

  private static minutesOf(time: string): number {
    const [hour, minute] = time.split(':')

    return Number(hour) * 60 + Number(minute ?? 0)
  }
}
