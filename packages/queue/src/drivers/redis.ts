import { RedisClient } from 'bun'
import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

export type RedisQueueOptions = {
  url?: string
  prefix?: string
  queue?: string
  /** Seconds a reservation is trusted for before the job is migrated back. */
  retryAfter?: number
  /**
   * Seconds between sweeps for due delayed jobs and expired reservations.
   *
   * Laravel sweeps on every `pop`, which on a busy queue is two extra round trips
   * for every job taken — two thirds of the traffic, spent asking whether anything
   * became due in the microsecond since the last time. Once a second is often
   * enough for a mechanism whose own resolution is whole seconds, and `0` restores
   * Laravel's behaviour exactly.
   */
  migrateEvery?: number
  client?: ConstructorParameters<typeof RedisClient>[1]
}

/**
 * Pop the next job and reserve it in one step.
 *
 * `LPOP` then `ZADD` from the client would leave a window in which the job
 * belongs to nobody: crash in between and the work is gone. The attempt count is
 * incremented here too, so it is the same script that decides both.
 */
const POP = `
local job = redis.call('lpop', KEYS[1])
local reserved = false

if(job ~= false) then
  reserved = cjson.decode(job)
  reserved['attempts'] = reserved['attempts'] + 1
  reserved = cjson.encode(reserved)
  redis.call('zadd', KEYS[2], ARGV[1], reserved)
end

return {job, reserved}
`

/** Move a reserved job onto the delayed set, so a retry waits its backoff. */
const RELEASE = `
redis.call('zrem', KEYS[2], ARGV[1])
redis.call('zadd', KEYS[1], ARGV[2], ARGV[1])
return true
`

/**
 * Move jobs whose score has passed back onto the main list.
 *
 * Used for two things: delayed jobs becoming available, and reservations that
 * expired because their worker died.
 */
const MIGRATE = `
local val = redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'limit', 0, ARGV[2])

if(next(val) ~= nil) then
  redis.call('zremrangebyrank', KEYS[1], 0, #val - 1)

  for i = 1, #val, 100 do
    redis.call('rpush', KEYS[2], unpack(val, i, math.min(i+99, #val)))
  end
end

return #val
`

const CLEAR = `
local size = redis.call('llen', KEYS[1]) + redis.call('zcard', KEYS[2]) + redis.call('zcard', KEYS[3])
redis.call('del', KEYS[1], KEYS[2], KEYS[3])
return size
`

/**
 * Jobs in Redis — `Illuminate\Queue\RedisQueue`.
 *
 * Three keys per queue: a list for what is ready, a sorted set of delayed jobs
 * scored by when they become available, and a sorted set of reserved jobs scored
 * by when their reservation expires. Every transition between them is a Lua
 * script, because each is a read plus a write that must not be interrupted.
 */
export class RedisQueue implements QueueDriver {
  readonly defaultQueue: string

  private readonly client: RedisClient
  private readonly prefix: string
  private readonly retryAfter: number
  private readonly migrateEvery: number

  /** When each queue was last swept, so the sweep can be throttled per queue. */
  private readonly sweptAt = new Map<string, number>()

  /**
   * The SHA of each script, once Redis has been told about it.
   *
   * `EVAL` sends the whole script body every time — 861 bytes per `pop` across the
   * three it ran. `EVALSHA` sends forty. The load is lazy and the fall back to
   * `EVAL` is real: a Redis that was restarted, or a replica that never saw the
   * load, answers `NOSCRIPT`, and the next call teaches it again.
   */
  private readonly shas = new Map<string, string>()

  constructor(
    readonly connectionName: string,
    options: RedisQueueOptions = {}
  ) {
    this.prefix = options.prefix ?? 'queues:'
    this.defaultQueue = options.queue ?? 'default'
    this.retryAfter = options.retryAfter ?? 90
    this.migrateEvery = options.migrateEvery ?? 1
    this.client = new RedisClient(
      options.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      options.client
    )
  }

  /**
   * Run a script by hash, teaching Redis the body only when it has to.
   *
   * The first call for a script pays one extra round trip to `SCRIPT LOAD`; every
   * call after sends the hash. `NOSCRIPT` means the server forgot — restarted, or
   * a different node — so the body goes again and the hash is relearned.
   */
  private async run(script: string, args: string[]): Promise<unknown> {
    const known = this.shas.get(script)

    if (known !== undefined) {
      try {
        return await this.client.send('EVALSHA', [known, ...args])
      } catch (error) {
        if (!String((error as Error).message).includes('NOSCRIPT')) throw error

        this.shas.delete(script)
      }
    }

    const sha = String(await this.client.send('SCRIPT', ['LOAD', script]))

    this.shas.set(script, sha)

    return this.client.send('EVALSHA', [sha, ...args])
  }

  async push(payload: JobPayload, queue?: string): Promise<string> {
    await this.client.send('RPUSH', [this.key(queue), JSON.stringify(payload)])

    return payload.uuid
  }

  async later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    const name = this.key(queue)

    await this.client.send('ZADD', [
      `${name}:delayed`,
      String(this.availableAt(delay)),
      JSON.stringify(payload)
    ])

    // Due within the sweep window, so the next pop has to look rather than wait.
    if (delay <= this.migrateEvery) this.sweepSoon(name)

    return payload.uuid
  }

  async pop(queue?: string): Promise<QueuedJob | null> {
    const name = queue ?? this.defaultQueue

    await this.migrate(name, false)

    const result = (await this.run(POP, [
      '2',
      this.key(name),
      `${this.key(name)}:reserved`,
      String(this.availableAt(this.retryAfter))
    ])) as [string | null, string | null] | null

    const reserved = result?.[1]
    if (!reserved) return null

    return new RedisJob(
      JSON.parse(reserved) as JobPayload,
      name,
      this.connectionName,
      reserved,
      this
    )
  }

  async size(queue?: string): Promise<number> {
    const name = this.key(queue)

    const [ready, delayed, reserved] = await Promise.all([
      this.client.send('LLEN', [name]),
      this.client.send('ZCARD', [`${name}:delayed`]),
      this.client.send('ZCARD', [`${name}:reserved`])
    ])

    return Number(ready) + Number(delayed) + Number(reserved)
  }

  async clear(queue?: string): Promise<number> {
    const name = this.key(queue)

    const cleared = await this.run(CLEAR, ['3', name, `${name}:delayed`, `${name}:reserved`])

    return Number(cleared)
  }

  /**
   * Delayed jobs that are due, and reservations that expired.
   *
   * Throttled per queue by `migrateEvery`, because `pop` calls it and `pop` is
   * called as fast as jobs are taken. Both sets are scored in whole seconds, so
   * sweeping more than once a second cannot find anything a one-second sweep would
   * miss — it only asks sooner. A due job therefore waits up to `migrateEvery`
   * seconds longer than its own delay, and an abandoned reservation is recovered
   * that much later; set it to `0` and every `pop` sweeps, as Laravel's does.
   *
   * Called directly — by `queue:retry`, or a test — it always sweeps. The throttle
   * belongs to the polling path, not to the operation.
   */
  async migrate(queue?: string, force = true): Promise<void> {
    const name = this.key(queue)

    if (!force && !this.sweepDue(name)) return

    const now = String(Math.floor(Date.now() / 1000))

    await this.run(MIGRATE, ['2', `${name}:delayed`, name, now, '100'])
    await this.run(MIGRATE, ['2', `${name}:reserved`, name, now, '100'])
  }

  /**
   * Something was just put where only a sweep will find it, so sweep next time.
   *
   * `release(0)` means retry now, and the retry goes onto the delayed set — where
   * a throttled sweep would leave it sitting for up to a second. The driver that
   * put it there knows, so it cancels its own throttle. Another process releasing
   * the same job cannot cancel this one's, which is the bound the throttle carries
   * and the reason `migrateEvery` is configurable.
   */
  private sweepSoon(name: string): void {
    this.sweptAt.delete(name)
  }

  /** Has enough time passed since this queue was last swept? */
  private sweepDue(name: string): boolean {
    if (this.migrateEvery <= 0) return true

    const now = Date.now()
    const last = this.sweptAt.get(name) ?? 0

    if (now - last < this.migrateEvery * 1000) return false

    this.sweptAt.set(name, now)

    return true
  }

  /** Called by a job releasing itself. */
  async releaseJob(reserved: string, queue: string, delay: number): Promise<void> {
    const name = this.key(queue)

    await this.run(RELEASE, [
      '2',
      `${name}:delayed`,
      `${name}:reserved`,
      reserved,
      String(this.availableAt(delay))
    ])

    if (delay <= this.migrateEvery) this.sweepSoon(name)
  }

  /** Called by a job that finished or failed. */
  async deleteJob(reserved: string, queue: string): Promise<void> {
    await this.client.send('ZREM', [`${this.key(queue)}:reserved`, reserved])
  }

  disconnect(): void {
    this.client.close()
  }

  private key(queue?: string): string {
    return this.prefix + (queue ?? this.defaultQueue)
  }

  private availableAt(seconds: number): number {
    return Math.floor(Date.now() / 1000) + Math.max(0, Math.trunc(seconds))
  }
}

class RedisJob implements QueuedJob {
  private deleted = false
  private released = false
  private failed = false

  constructor(
    readonly payload: JobPayload,
    readonly queue: string,
    readonly connectionName: string,
    /** The exact string sitting in the reserved set — the handle to remove it. */
    private readonly reserved: string,
    private readonly driver: RedisQueue
  ) {}

  attempts(): number {
    return this.payload.attempts
  }

  async delete(): Promise<void> {
    this.deleted = true

    await this.driver.deleteJob(this.reserved, this.queue)
  }

  async release(delay = 0): Promise<void> {
    this.released = true

    await this.driver.releaseJob(this.reserved, this.queue, delay)
  }

  async fail(_error: unknown): Promise<void> {
    this.failed = true

    await this.driver.deleteJob(this.reserved, this.queue)
  }

  isDeleted(): boolean {
    return this.deleted
  }

  isReleased(): boolean {
    return this.released
  }

  hasFailed(): boolean {
    return this.failed
  }
}
