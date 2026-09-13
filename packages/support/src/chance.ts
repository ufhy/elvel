/**
 * Two small things that both come down to "do this sometimes, predictably in a
 * test": a weighted coin, and a fixed execution window.
 */

let draw: () => number = () => Math.random()
let forced: boolean[] = []

/**
 * `Lottery.odds(1, 100)` — a callable that wins one time in a hundred.
 *
 * For sampling: log one request in a hundred, prune on one boot in fifty. Worth
 * having rather than a bare `Math.random()` because it can be fixed for a test,
 * and because `1 / 100 > Math.random()` is written the wrong way round about
 * half the time.
 */
export class Lottery<T = void, F = void> {
  private onWin: (() => T) | undefined
  private onLose: (() => F) | undefined

  constructor(
    private readonly chances: number,
    private readonly outOf: number
  ) {
    if (outOf <= 0) throw new Error('Lottery needs to be out of at least 1.')
  }

  static odds<T = void, F = void>(chances: number, outOf = 1): Lottery<T, F> {
    return new Lottery<T, F>(chances, outOf)
  }

  winner(callback: () => T): this {
    this.onWin = callback

    return this
  }

  loser(callback: () => F): this {
    this.onLose = callback

    return this
  }

  /** Draw. Returns the winner's or loser's result, or the boolean if neither. */
  choose(): T | F | boolean {
    const won = Lottery.next() <= this.chances / this.outOf

    if (won) return this.onWin ? this.onWin() : true

    return this.onLose ? this.onLose() : false
  }

  /** Every draw wins, until `restore()`. */
  static alwaysWin(): void {
    draw = () => 0
  }

  /** Every draw loses. */
  static alwaysLose(): void {
    draw = () => 1
  }

  /**
   * Fix a sequence of outcomes, consumed in order.
   *
   * Once the sequence runs out the draws are random again, which is what makes
   * "the first two win and then whatever" expressible.
   */
  static fix(results: boolean[]): void {
    forced = [...results]
  }

  static restore(): void {
    draw = () => Math.random()
    forced = []
  }

  private static next(): number {
    const fixed = forced.shift()

    if (fixed !== undefined) return fixed ? 0 : 1

    return draw()
  }
}

/**
 * Run something in a fixed minimum window, whatever it does.
 *
 * The defence against user enumeration by timing: a sign-in that fails because
 * the address is unknown returns in a millisecond, and one that fails on the
 * password spends a hundred hashing — so the difference tells an attacker which
 * addresses exist. A timebox makes both take the same time.
 *
 * A throw is held until the window closes and then re-thrown, because an error
 * that escapes early leaks exactly the timing the box exists to hide.
 */
export class Timebox {
  private early = false

  /** Let the callback return as soon as it is done. For a test. */
  returnEarly(): this {
    this.early = true

    return this
  }

  dontReturnEarly(): this {
    this.early = false

    return this
  }

  async call<T>(callback: () => Promise<T> | T, milliseconds: number): Promise<T> {
    const started = Bun.nanoseconds()

    let result: T | undefined
    let thrown: unknown

    try {
      result = await callback()
    } catch (error) {
      thrown = error
    }

    const spent = (Bun.nanoseconds() - started) / 1_000_000
    const remaining = milliseconds - spent

    if (!this.early && remaining > 0) await Bun.sleep(remaining)

    if (thrown !== undefined) throw thrown

    return result as T
  }
}

/** `timebox(fn, 200)` — the common case, without holding an instance. */
export function timebox<T>(callback: () => Promise<T> | T, milliseconds: number): Promise<T> {
  return new Timebox().call(callback, milliseconds)
}
