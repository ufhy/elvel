/**
 * One rate limit.
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
    readonly decaySeconds: number = 60,
    /** See `response()`. */
    readonly refusal?: LimitRefusal,
    /** See `after()`. */
    readonly onExceeded?: (context: LimitContext) => void | Promise<void>,
    /** See `fallback()`. */
    readonly fallbackKey?: string
  ) {}

  static perSecond(maxAttempts: number, seconds = 1): Limit {
    return new Limit('', maxAttempts, seconds)
  }

  static perMinute(maxAttempts: number, minutes = 1): Limit {
    return new Limit('', maxAttempts, 60 * minutes)
  }

  /** `perMinutes(5, 100)` — a hundred in five minutes, said the way it is meant. */
  static perMinutes(minutes: number, maxAttempts: number): Limit {
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
    return this.derive({ key: String(key) })
  }

  /**
   * What a refusal answers with.
   *
   * Every limiter in the application threw the same
   * `TooManyRequestsError('Too Many Attempts.')`, which is the wrong answer for
   * most of them: an API wants a JSON body naming the limit, a sign-in form
   * wants a page, and a webhook endpoint wants neither.
   *
   * A factory rather than a `Response`: a response body can be read once, so one
   * shared instance would answer the first refused caller and hand every one
   * after it an empty body.
   */
  response(build: LimitRefusal): Limit {
    return this.derive({ refusal: build })
  }

  /** Run when the limit is hit — log it, alert on it, ban the caller. */
  after(callback: (context: LimitContext) => void | Promise<void>): Limit {
    return this.derive({ onExceeded: callback })
  }

  /**
   * What to count against when the key resolves to nothing.
   *
   * An unauthenticated request has no user id, and a limit keyed on one would
   * otherwise count every anonymous caller into the same empty-string bucket —
   * one visitor exhausting the limit for all of them.
   */
  fallback(key: string): Limit {
    return this.derive({ fallbackKey: key })
  }

  /** The key to count against, given what is actually available. */
  keyOrFallback(): string {
    return this.key !== '' ? this.key : (this.fallbackKey ?? '')
  }

  private derive(changes: Partial<Limit>): Limit {
    return new (this.constructor as typeof Limit)(
      changes.key ?? this.key,
      changes.maxAttempts ?? this.maxAttempts,
      changes.decaySeconds ?? this.decaySeconds,
      changes.refusal ?? this.refusal,
      changes.onExceeded ?? this.onExceeded,
      changes.fallbackKey ?? this.fallbackKey
    )
  }
}

/** What a limiter answers a refused caller with. */
export type LimitRefusal = (context: LimitContext) => Response | Promise<Response>

/** What a refusal knows about the caller it is refusing. */
export type LimitContext = {
  request: Request
  key: string
  maxAttempts: number
  /** Seconds until the window opens again. */
  retryAfter: number
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
