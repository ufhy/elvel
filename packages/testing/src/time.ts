/**
 * What a test needs of the clock, without depending on `@elvel/support`.
 *
 * The same structural trick the rest of this package uses. `@elvel/support`
 * exports exactly this shape, so `travel(Clock, …)` type-checks with no import.
 */
export type Freezable = {
  freeze(at?: Date | number): void
  advance(milliseconds: number): void
  travelTo(when: Date | number): void
  restore(): void
  now(): number
}

/** Clocks a test has moved, so `restoreTime()` can put them all back. */
const moved = new Set<Freezable>()

/**
 * Move the clock, and remember to put it back.
 *
 * A test reaching for `@elvel/support` to control time is a test reaching past
 * the thing it is testing with, and one that forgets to restore poisons every
 * test after it — the failure lands somewhere else entirely, which is the worst
 * kind.
 *
 * ```ts
 * afterEach(restoreTime)
 *
 * test('a token expires', () => {
 *   freezeTime(Clock)
 *   travel(Clock).days(31)
 * })
 * ```
 */
export function freezeTime(clock: Freezable, at?: Date | number): void {
  moved.add(clock)
  clock.freeze(at)
}

/** Move to a moment, without freezing there. */
export function travelTo(clock: Freezable, when: Date | number): void {
  moved.add(clock)
  clock.travelTo(when)
}

/** Put every clock this test moved back. Call it from `afterEach`. */
export function restoreTime(): void {
  for (const clock of moved) clock.restore()

  moved.clear()
}

/** Units, so a test reads as the thing it is describing. */
export type Travel = {
  milliseconds(count: number): void
  seconds(count: number): void
  minutes(count: number): void
  hours(count: number): void
  days(count: number): void
  weeks(count: number): void
  /** Back, for a token that should already have expired. */
  back(): Travel
}

/**
 * `travel(Clock).days(31)`.
 *
 * The units read forwards; `back()` flips the sign for the case a test usually
 * wants it — something that expired before now.
 */
export function travel(clock: Freezable, direction = 1): Travel {
  moved.add(clock)

  const by = (milliseconds: number) => clock.advance(milliseconds * direction)

  return {
    milliseconds: by,
    seconds: (count) => by(count * 1000),
    minutes: (count) => by(count * 60_000),
    hours: (count) => by(count * 3_600_000),
    days: (count) => by(count * 86_400_000),
    weeks: (count) => by(count * 604_800_000),
    back: () => travel(clock, -1)
  }
}

/** What an application must expose for `withoutExceptionHandling` to work. */
export type Rethrowable = { rethrowExceptions: boolean }

/**
 * Put the exception back on the surface.
 *
 * A test that gets a 500 sees the rendered error page: the stack, the message
 * and the line are all inside the handler that turned the exception into a
 * response, and the way to see them was to edit the application.
 *
 * ```ts
 * await withoutExceptionHandling(Application, () => test(app).get('/boom'))
 * ```
 *
 * Restored in a `finally`, because a test that threw is exactly the one that
 * would otherwise leave it on.
 */
export async function withoutExceptionHandling<T>(
  application: Rethrowable,
  body: () => Promise<T> | T
): Promise<T> {
  const previous = application.rethrowExceptions

  application.rethrowExceptions = true

  try {
    return await body()
  } finally {
    application.rethrowExceptions = previous
  }
}
