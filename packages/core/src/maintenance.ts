import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** What `elvel down` writes, and the middleware reads back. */
export type MaintenancePayload = {
  /** Paths that answer normally anyway — a health check, a payment webhook. */
  except?: string[]
  /** Send everything else here instead of refusing it. */
  redirect?: string
  /** Seconds for `Retry-After`. */
  retry?: number
  /** Seconds for the `Refresh` header, so a browser reloads itself. */
  refresh?: number
  /** The phrase that unlocks a bypass cookie. */
  secret?: string
  status?: number
  /** HTML rendered when `down` ran, not when the request arrived. */
  template?: string
  /** When it went down, for `elvel about` and the log. */
  since: number
}

/**
 * Maintenance mode, kept in a **file**.
 *
 * A file rather than the cache, deliberately. Laravel offers both and defaults to
 * a file for the same reason: the cache store may be the database or Redis, and the
 * most likely moment to need maintenance mode is when one of those is the thing
 * that is broken. A mode that cannot be switched on while the database is down is
 * not a maintenance mode.
 */
/**
 * What a maintenance driver has to do.
 *
 * Two of them, and the choice is a real trade rather than a preference — see the
 * note on the cache driver below.
 */
export interface MaintenanceDriver {
  active(): Promise<boolean>
  data(): Promise<MaintenancePayload | undefined>
  activate(payload: MaintenancePayload): Promise<void>
  deactivate(): Promise<boolean>
}

export class MaintenanceMode implements MaintenanceDriver {
  constructor(private readonly file: string) {}

  /** Is the application down? Read per request, so `up` takes effect at once. */
  async active(): Promise<boolean> {
    return Bun.file(this.file).exists()
  }

  /** The payload, or undefined when the application is up. */
  async data(): Promise<MaintenancePayload | undefined> {
    try {
      return (await Bun.file(this.file).json()) as MaintenancePayload
    } catch {
      // Missing, or half-written by a deploy that raced us. Either way the caller
      // should treat it as "no usable payload" rather than crash the request.
      return undefined
    }
  }

  async activate(payload: MaintenancePayload): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await Bun.write(this.file, JSON.stringify(payload, null, 2))
  }

  /** Bring it back up. Returns false when it was not down. */
  async deactivate(): Promise<boolean> {
    if (!(await this.active())) return false

    await unlink(this.file)

    return true
  }

  get path(): string {
    return this.file
  }
}

/** How long a bypass cookie is trusted. Laravel's twelve hours. */
const BYPASS_LIFETIME_SECONDS = 12 * 3600

export const BYPASS_COOKIE = 'elvel_maintenance'

/**
 * A bypass cookie — `MaintenanceModeBypassCookie`.
 *
 * The value is `{ expiresAt, mac }`, and the secret itself never leaves the
 * server: the cookie proves it was issued by someone who knew the secret, and it
 * expires on its own, so a copied cookie is a temporary problem rather than a
 * permanent key.
 */
export function issueBypassCookie(secret: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + BYPASS_LIFETIME_SECONDS

  return Buffer.from(JSON.stringify({ expiresAt, mac: sign(expiresAt, secret) })).toString(
    'base64url'
  )
}

export function bypassCookieIsValid(cookie: string | undefined, secret: string): boolean {
  if (!cookie) return false

  try {
    const payload = JSON.parse(Buffer.from(cookie, 'base64url').toString()) as {
      expiresAt?: unknown
      mac?: unknown
    }

    if (typeof payload.expiresAt !== 'number' || typeof payload.mac !== 'string') return false
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) return false

    const expected = Buffer.from(sign(payload.expiresAt, secret))
    const given = Buffer.from(payload.mac)

    // Constant time, as everywhere a MAC is compared: an early return leaks how
    // much of a forgery was right.
    return expected.length === given.length && timingSafeEqual(expected, given)
  } catch {
    return false
  }
}

function sign(expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(String(expiresAt)).digest('hex')
}

/** A phrase for `--with-secret`: URL-safe, and long enough not to be guessed. */
export function generateSecret(): string {
  return randomBytes(16).toString('hex')
}

/** The slice of a cache store the maintenance driver needs. */
export type MaintenanceStore = {
  get<T>(key: string): Promise<T | null>
  forever(key: string, value: unknown): Promise<boolean>
  forget(key: string): Promise<boolean>
  has(key: string): Promise<boolean>
}

/**
 * Maintenance mode kept in the **cache**, for a cluster.
 *
 * A file lives on one machine, so `elvel down` on a node behind a load
 * balancer takes exactly that node down and leaves the rest serving. The cache
 * is shared, which is the whole reason to use it.
 *
 * It is not the default, and should not be: the likeliest moment to need
 * maintenance mode is when the database or Redis is the thing being repaired,
 * and a switch that needs the broken component is no switch at all. Laravel
 * makes the same call. Use this when the cluster matters more than that risk,
 * and keep the file driver in mind for the day the store is down.
 */
export class CachedMaintenanceMode {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly key = 'elvel:maintenance'
  ) {}

  async active(): Promise<boolean> {
    return this.store.has(this.key)
  }

  async data(): Promise<MaintenancePayload | undefined> {
    return (await this.store.get<MaintenancePayload>(this.key)) ?? undefined
  }

  async activate(payload: MaintenancePayload): Promise<void> {
    // Forever: a maintenance window that expired on its own would bring the
    // application back up while the work was still going.
    await this.store.forever(this.key, payload)
  }

  async deactivate(): Promise<boolean> {
    if (!(await this.active())) return false

    await this.store.forget(this.key)

    return true
  }

  /** Nothing on disk; here so the two drivers share one shape. */
  get path(): string {
    return `cache:${this.key}`
  }
}
