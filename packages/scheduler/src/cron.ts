/** The five cron fields, in order. */
const MINUTE = 0
const HOUR = 1
const DAY_OF_MONTH = 2
const MONTH = 3
const DAY_OF_WEEK = 4

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** `@daily` and friends, as every cron implementation understands them. */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}

const RANGES: Record<number, [number, number]> = {
  [MINUTE]: [0, 59],
  [HOUR]: [0, 23],
  [DAY_OF_MONTH]: [1, 31],
  [MONTH]: [1, 12],
  [DAY_OF_WEEK]: [0, 6]
}

type Field = {
  /** `5#3` in day-of-week: the *n*th weekday of the month. */
  nth?: { weekday: number; occurrence: number }
  /** `15W` in day-of-month: the weekday nearest that date. */
  nearestWeekday?: number
  /** Values this field accepts, or null for `*` — "any". */
  values: Set<number> | null
  /** `L` in the day-of-month field: the last day, whatever month it is. */
  last: boolean
}

/** A moment, broken into the pieces cron compares against. */
export type CronParts = {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
  year: number
}

/**
 * Read a moment in a specific zone.
 *
 * `Intl` rather than arithmetic on the offset: an offset is wrong twice a year.
 * A schedule that says "every day at 02:30 Europe/Berlin" has to mean local
 * 02:30 on both sides of a daylight-saving change, and only the platform's
 * timezone database knows when that is.
 */
export function partsIn(date: Date, timeZone?: string): CronParts {
  if (!timeZone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
      year: date.getFullYear()
    }
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short'
  })

  const parts: Record<string, string> = {}
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value

  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    year: Number(parts.year)
  }
}

/** Days in the month a moment falls in, for `L`. */
function lastDayOfMonth(parts: CronParts): number {
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
}

/** Which Tuesday of the month the 16th is — 1 for the 1st–7th, 2 for the 8th–14th… */
function occurrenceInMonth(dayOfMonth: number): number {
  return Math.floor((dayOfMonth - 1) / 7) + 1
}

/**
 * The weekday nearest a date, without leaving the month — cron's `W`.
 *
 * One back, one forward, two back, two forward, which is the order every cron
 * implementation searches in: a Saturday resolves to the Friday before, a Sunday
 * to the Monday after, and the 1st falling on a Sunday goes forward to the 2nd
 * rather than back into the previous month.
 */
function nearestWeekdayTo(target: number, parts: CronParts): number {
  const days = lastDayOfMonth(parts)
  const clamped = Math.min(Math.max(target, 1), days)

  const weekdayOf = (day: number) =>
    new Date(Date.UTC(parts.year, parts.month - 1, day)).getUTCDay()

  if (weekdayOf(clamped) !== 0 && weekdayOf(clamped) !== 6) return clamped

  for (const offset of [-1, 1, -2, 2]) {
    const candidate = clamped + offset

    if (candidate < 1 || candidate > days) continue

    const weekday = weekdayOf(candidate)

    if (weekday !== 0 && weekday !== 6) return candidate
  }

  return clamped
}

/**
 * A parsed cron expression.
 *
 * Written rather than taken from a package for two reasons: it is a hundred lines
 * of well-specified behaviour, and the one part that is easy to get wrong is worth
 * owning — see `matches()` for the day-of-month/day-of-week rule.
 *
 * Supported: `*`, lists (`1,15`), ranges (`1-5`), steps (`* /15`, `1-23/2`), month
 * and day names (`JAN`, `MON`), the `@daily` macros, and `L` for the last day of
 * the month.
 */
export class CronExpression {
  private constructor(
    readonly expression: string,
    private readonly fields: Field[]
  ) {}

  static parse(expression: string): CronExpression {
    const normalised = (MACROS[expression.trim().toLowerCase()] ?? expression).trim()
    const parts = normalised.split(/\s+/)

    if (parts.length !== 5) {
      throw new Error(
        `Cron expression [${expression}] must have five fields: minute hour day-of-month month day-of-week.`
      )
    }

    return new CronExpression(
      normalised,
      parts.map((part, index) => CronExpression.parseField(part, index))
    )
  }

  /** Replace one field, as Laravel's `spliceIntoPosition` does. */
  spliceField(position: number, value: string | number): CronExpression {
    const parts = this.expression.split(/\s+/)
    parts[position] = String(value)

    return CronExpression.parse(parts.join(' '))
  }

  /**
   * Does this expression fire during the minute `date` falls in?
   *
   * The day rule is the one that surprises people, and it is POSIX behaviour:
   * when *both* day-of-month and day-of-week are restricted, the expression
   * matches if **either** matches — `0 0 1 * MON` is "the 1st, and also every
   * Monday". When only one is restricted, that one has to match.
   */
  matches(date: Date, timeZone?: string): boolean {
    const parts = partsIn(date, timeZone)

    if (!this.fieldMatches(MINUTE, parts.minute)) return false
    if (!this.fieldMatches(HOUR, parts.hour)) return false
    if (!this.fieldMatches(MONTH, parts.month)) return false

    return this.dayMatches(parts)
  }

  /** The next minute at or after `from` at which this fires. */
  nextRunAt(from: Date = new Date(), timeZone?: string): Date {
    // Start at the next whole minute: a cron fires on the minute, and the seconds
    // of `from` are not part of the question.
    const candidate = new Date(from.getTime())
    candidate.setSeconds(0, 0)
    candidate.setMinutes(candidate.getMinutes() + 1)

    // Four years covers the worst legitimate case, 29 February on a weekday.
    const limit = 4 * 366 * 24 * 60

    for (let step = 0; step < limit; step += 1) {
      const parts = partsIn(candidate, timeZone)

      if (!this.fieldMatches(MONTH, parts.month) || !this.dayMatches(parts)) {
        // Nothing this day can match, so jump to the next local midnight rather
        // than testing all 1,440 of its minutes.
        candidate.setMinutes(candidate.getMinutes() + (1440 - (parts.hour * 60 + parts.minute)))
        continue
      }

      if (this.fieldMatches(HOUR, parts.hour) && this.fieldMatches(MINUTE, parts.minute)) {
        return candidate
      }

      candidate.setMinutes(candidate.getMinutes() + 1)
    }

    throw new Error(`Cron expression [${this.expression}] has no next run date.`)
  }

  toString(): string {
    return this.expression
  }

  private dayMatches(parts: CronParts): boolean {
    const dom = this.fields[DAY_OF_MONTH] as Field
    const dow = this.fields[DAY_OF_WEEK] as Field

    const domRestricted = dom.values !== null || dom.last || dom.nearestWeekday !== undefined
    const dowRestricted = dow.values !== null || dow.nth !== undefined

    const domHit = dom.last
      ? parts.dayOfMonth === lastDayOfMonth(parts)
      : dom.nearestWeekday !== undefined
        ? parts.dayOfMonth === nearestWeekdayTo(dom.nearestWeekday, parts)
        : this.fieldMatches(DAY_OF_MONTH, parts.dayOfMonth)

    const dowHit =
      dow.nth === undefined
        ? this.fieldMatches(DAY_OF_WEEK, parts.dayOfWeek)
        : parts.dayOfWeek === dow.nth.weekday &&
          occurrenceInMonth(parts.dayOfMonth) === dow.nth.occurrence

    if (domRestricted && dowRestricted) return domHit || dowHit
    if (domRestricted) return domHit
    if (dowRestricted) return dowHit

    return true
  }

  private fieldMatches(position: number, value: number): boolean {
    const field = this.fields[position] as Field

    return field.values === null || field.values.has(value)
  }

  private static parseField(part: string, position: number): Field {
    // `?` means "no opinion" in Quartz-style expressions, and is treated as `*`.
    if (part === '*' || part === '?') return { values: null, last: false }

    if (position === DAY_OF_MONTH && part.toUpperCase() === 'L') {
      return { values: null, last: true }
    }

    /**
     * `5#3` — the third Friday of the month.
     *
     * Standard cron, and the form every "second Tuesday" schedule is written in.
     * There is deliberately no helper pointing at it: a frequency method called
     * `thirdFriday()` would need sixty of them.
     */
    if (position === DAY_OF_WEEK && part.includes('#')) {
      const [weekdayPart, occurrencePart] = part.split('#')
      const weekday = CronExpression.parseValue(weekdayPart as string, position)
      const occurrence = Number(occurrencePart)

      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 5) {
        throw new Error(
          `Cron field [${part}] asks for occurrence ${occurrencePart}: a weekday happens between one and five times in a month.`
        )
      }

      return { values: null, last: false, nth: { weekday: weekday % 7, occurrence } }
    }

    /**
     * `15W` — the weekday nearest the 15th, without leaving the month.
     *
     * For "the payroll runs on the 15th, or the working day beside it". The
     * search order is the one every cron implementation uses: one day back, one
     * forward, two back, two forward — so a Saturday goes to Friday and a Sunday
     * to Monday, and the 1st falling on a Sunday goes forward to the 2nd rather
     * than back into the previous month.
     */
    if (position === DAY_OF_MONTH && /^\d+W$/i.test(part)) {
      return { values: null, last: false, nearestWeekday: Number(part.slice(0, -1)) }
    }

    const values = new Set<number>()

    for (const piece of part.split(',')) {
      for (const value of CronExpression.parsePiece(piece, position)) values.add(value)
    }

    if (values.size === 0) {
      throw new Error(`Cron field [${part}] does not match anything.`)
    }

    return { values, last: false }
  }

  private static parsePiece(piece: string, position: number): number[] {
    const [range, stepPart] = piece.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron step [${stepPart}] must be a positive whole number.`)
    }

    const [min, max] = RANGES[position] as [number, number]

    let start: number
    let end: number

    if (range === '*' || range === '?' || range === undefined) {
      start = min
      end = max
    } else if (range.includes('-')) {
      const [left, right] = range.split('-')
      start = CronExpression.parseValue(left as string, position)
      end = CronExpression.parseValue(right as string, position)
    } else {
      start = CronExpression.parseValue(range, position)
      // A bare value with a step means "from here to the end of the field",
      // which is how `5/15` is read everywhere.
      end = stepPart === undefined ? start : max
    }

    if (start > end) {
      throw new Error(`Cron range [${range}] starts after it ends.`)
    }

    const values: number[] = []
    for (let value = start; value <= end; value += step) values.push(value)

    return values
  }

  private static parseValue(raw: string, position: number): number {
    const text = raw.trim().toLowerCase()

    if (position === MONTH) {
      const named = MONTHS.indexOf(text.slice(0, 3))
      if (named !== -1) return named + 1
    }

    if (position === DAY_OF_WEEK) {
      const named = DAYS.indexOf(text.slice(0, 3))
      if (named !== -1) return named
    }

    const value = Number(text)

    if (!Number.isInteger(value)) {
      throw new Error(`Cron value [${raw}] is not a number this field understands.`)
    }

    // Sunday is both 0 and 7; normalise so a set lookup is enough.
    if (position === DAY_OF_WEEK && value === 7) return 0

    const [min, max] = RANGES[position] as [number, number]

    if (value < min || value > max) {
      throw new Error(`Cron value [${raw}] is outside the range ${min}-${max} for this field.`)
    }

    return value
  }
}

export { DAY_OF_MONTH, DAY_OF_WEEK, HOUR, MINUTE, MONTH }
