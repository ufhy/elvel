/**
 * One rate limit — `Illuminate\Cache\RateLimiting\Limit`.
 *
 * The counter already exists (`RateLimiter`); this is the vocabulary for saying
 * *what* the limit is, so a named limiter can return one, several, or none:
 *
 * ```ts
 * Limit.perMinute(60).by(request.ip)
 * [Limit.perMinute(500).by(user.id), Limit.perDay(2_000).by(user.id)]
 * Limit.none()
 * ```
 *
 * Several at once is not decoration: "60 a minute *and* 1000 a day" is two
 * windows, and neither expresses the other.
 */
export class Limit {
  constructor(
    /** What the count is kept against — an id, an address, a route name. */
    readonly key: string = '',
    readonly maxAttempts: number = 60,
    readonly decaySeconds: number = 60
  ) {}

  static perSecond(maxAttempts: number, seconds = 1): Limit {
    return new Limit('', maxAttempts, seconds)
  }

  static perMinute(maxAttempts: number, minutes = 1): Limit {
    return new Limit('', maxAttempts, 60 * minutes)
  }

  static perHour(maxAttempts: number, hours = 1): Limit {
    return new Limit('', maxAttempts, 3600 * hours)
  }

  static perDay(maxAttempts: number, days = 1): Limit {
    return new Limit('', maxAttempts, 86_400 * days)
  }

  /**
   * No limit at all.
   *
   * Its own value rather than `null`, so a limiter can say "this caller is
   * exempt" in the same shape it says everything else — and a caller reading the
   * code sees the exemption instead of inferring it from an absence.
   */
  static none(): Limit {
    return new Unlimited()
  }

  /** The key this limit counts against. */
  by(key: string | number): Limit {
    return new (this.constructor as typeof Limit)(String(key), this.maxAttempts, this.decaySeconds)
  }
}

/** `Limit.none()` — recognised by the middleware and skipped. */
export class Unlimited extends Limit {
  constructor() {
    super('', Number.POSITIVE_INFINITY, 60)
  }
}

export function isUnlimited(limit: Limit): boolean {
  return limit instanceof Unlimited
}
