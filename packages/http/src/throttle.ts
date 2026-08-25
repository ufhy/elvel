import { isUnlimited, Limit, type RateLimiter } from '@elvel/cache'
import { app, HttpException } from '@elvel/core'
import { Elysia } from 'elysia'
import { clientIp, type ProxyOptions, type SocketAddress } from './proxies.ts'

/** 429, with the headers a client needs to back off intelligently. */
export class TooManyRequestsError extends HttpException {
  constructor(message = 'Too Many Attempts.', headers: Record<string, string> = {}) {
    super(429, message, headers)
    this.name = 'TooManyRequestsError'
  }
}

/** What a named limiter is handed to decide with. */
export type LimiterContext = {
  request: Request
  /** The caller's address, already resolved through any trusted proxy. */
  ip: string
  /** The authenticated user, when `@elvel/auth` is registered and someone is. */
  user?: { id?: unknown } | undefined
}

export type LimiterCallback = (
  context: LimiterContext
) => Limit | Limit[] | Promise<Limit | Limit[]>

/**
 * Named rate limiters — `RateLimiter::for('uploads', …)`.
 *
 * The registry is here rather than in `@elvel/cache` because a limiter decides
 * from the *request*: who is calling, what they are asking for. The counting
 * lives in the cache package, where it belongs.
 */
export class LimiterRegistry {
  private readonly limiters = new Map<string, LimiterCallback>()

  for(name: string, callback: LimiterCallback): this {
    this.limiters.set(name, callback)

    return this
  }

  get(name: string): LimiterCallback | undefined {
    return this.limiters.get(name)
  }

  names(): string[] {
    return [...this.limiters.keys()].sort()
  }
}

export type ThrottleOptions = {
  /** Attempts allowed in the window. */
  max?: number
  /** Window length in seconds. */
  decay?: number
  /** Prefix on the counter key, so two routes do not share one budget. */
  prefix?: string
}

/**
 * Rate limit the routes of the plugin it is used in.
 *
 * ```ts
 * new Elysia().use(throttle({ max: 60, decay: 60 }))
 * new Elysia().use(throttle('uploads'))            // a named limiter
 * ```
 *
 * For one route or one group, `throttle:60,1` as middleware says the same thing
 * and reads better beside the route it guards:
 *
 * ```ts
 * Route.post('/sign-in', [SignInController, 'store']).middleware('throttle:6,1')
 * ```
 *
 * Transcribed from `Illuminate\Routing\Middleware\ThrottleRequests`, including
 * the parts that are easy to get subtly wrong:
 *
 * - the counter is **hit before** the handler runs, so a slow handler cannot be
 *   used to exceed the limit by running many at once
 * - a rejected request carries `Retry-After` **and** `X-RateLimit-Reset`, so a
 *   client can wait the right amount rather than guessing
 * - the signature is the user when there is one, the address otherwise: two
 *   people behind one office NAT should not share a login budget
 */
export function throttle(limiter: string | ThrottleOptions = {}): Elysia {
  const named = typeof limiter === 'string' ? limiter : undefined
  const options = typeof limiter === 'string' ? {} : limiter

  return new Elysia({ name: `elvel:throttle:${named ?? `${options.max}/${options.decay}`}` })
    .onBeforeHandle({ as: 'scoped' }, (context) =>
      enforceThrottle(context as never, named, options)
    )
    .onAfterHandle({ as: 'scoped' }, (context) => writeRateHeaders(context as never))
}

/**
 * The check itself, callable outside the plugin.
 *
 * Extracted so the `throttle` middleware alias runs this rather than a second
 * copy of it. Two implementations of a rate limit is one implementation and one
 * bug, and the bug is always the one that counts wrong.
 */
export async function enforceThrottle(
  context: { request: Request },
  named: string | undefined,
  options: ThrottleOptions
): Promise<void> {
  const limits = await resolveLimits(named, options, context as never)

  for (const limit of limits) {
    if (isUnlimited(limit)) continue

    const counter = rateLimiter()

    if (await counter.tooManyAttempts(limit.key, limit.maxAttempts)) {
      const retryAfter = await counter.availableIn(limit.key)

      throw new TooManyRequestsError('Too Many Attempts.', {
        'X-RateLimit-Limit': String(limit.maxAttempts),
        'X-RateLimit-Remaining': '0',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + retryAfter)
      })
    }

    await counter.hit(limit.key, limit.decaySeconds)

    // Kept for the response hook, which cannot recompute them without knowing
    // which limits this request was measured against.
    applied(context as never).push(limit)
  }
}

/**
 * The headers a client backs off with.
 *
 * The tightest window wins: with two limits in play, reporting the last one read
 * would tell a client it has 48 requests left while the minute window is one
 * away from refusing it. Laravel keeps whichever remaining count is lower.
 */
export async function writeRateHeaders(context: {
  request: Request
  set: { headers: Record<string, string> }
}): Promise<void> {
  const limits = applied(context as never)
  if (limits.length === 0) return

  const counter = rateLimiter()
  let tightest: { max: number; left: number } | undefined

  for (const limit of limits) {
    const left = await counter.remaining(limit.key, limit.maxAttempts)

    if (!tightest || left < tightest.left) tightest = { max: limit.maxAttempts, left }
  }

  if (!tightest) return

  context.set.headers['X-RateLimit-Limit'] = String(tightest.max)
  context.set.headers['X-RateLimit-Remaining'] = String(tightest.left)
}

/** Limits applied to one request, kept per request rather than on the plugin. */
const appliedLimits = new WeakMap<Request, Limit[]>()

function applied(context: { request: Request }): Limit[] {
  const existing = appliedLimits.get(context.request)
  if (existing) return existing

  const fresh: Limit[] = []
  appliedLimits.set(context.request, fresh)

  return fresh
}

function rateLimiter(): RateLimiter {
  if (!app().bound('cache.limiter')) {
    throw new Error('Rate limiting needs a cache. Register CacheServiceProvider in config/app.ts.')
  }

  return app('cache.limiter')
}

async function resolveLimits(
  named: string | undefined,
  options: ThrottleOptions,
  context: { request: Request; server?: { requestIP(request: Request): SocketAddress } }
): Promise<Limit[]> {
  const ip = addressFor(context)

  if (named === undefined) {
    const max = options.max ?? 60
    const decay = options.decay ?? 60
    const signature = `${options.prefix ?? ''}${signatureFor(context, ip)}`

    return [new Limit(signature, max, decay)]
  }

  const callback = limiters().get(named)

  if (!callback) {
    throw new Error(
      `Rate limiter [${named}] is not defined. Register it with limiters().for('${named}', …) in a service provider.`
    )
  }

  const resolved = await callback({
    request: context.request,
    ip,
    user: currentUser()
  })

  /**
   * Each limit gets its own counter, keyed by its window as well as its subject.
   *
   * A limiter returning `[perMinute(3).by(ip), perDay(50).by(ip)]` describes two
   * windows over the same subject. Without the window in the key both would
   * increment one counter, so every request would count twice and the tighter
   * limit would trip at half its stated number — which is what happened the first
   * time this was driven over the network.
   *
   * A keyless limit falls back to the request signature, or every caller would
   * share one counter, which is the opposite of a rate limit.
   */
  return (Array.isArray(resolved) ? resolved : [resolved]).map((limit) => {
    const subject = limit.key === '' ? signatureFor(context, ip) : limit.key

    return limit.by(`${named}:${limit.decaySeconds}s:${subject}`)
  })
}

/** The authenticated user's id when there is one, the address otherwise. */
function signatureFor(context: { request: Request }, ip: string): string {
  const user = currentUser()

  if (user?.id !== undefined && user.id !== null) return `user:${String(user.id)}`

  return `ip:${ip}|${new URL(context.request.url).pathname}`
}

function currentUser(): { id?: unknown } | undefined {
  if (!app().bound('auth')) return undefined

  try {
    return (app('auth') as unknown as { user?: () => { id?: unknown } | undefined }).user?.()
  } catch {
    // A request with no auth scope entered is not an error here: it means nobody
    // is signed in, which the address branch already covers.
    return undefined
  }
}

function addressFor(context: {
  request: Request
  server?: { requestIP(request: Request): SocketAddress }
}): string {
  const socket = context.server?.requestIP(context.request)

  return clientIp(context.request, socket, {
    trustedProxies: app().config.get<string[] | '*'>('http.trustedProxies', [])
  } as ProxyOptions)
}

/** The application's named limiters. */
export function limiters(): LimiterRegistry {
  return app('limiters')
}
