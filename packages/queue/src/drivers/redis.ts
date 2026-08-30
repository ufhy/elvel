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
  /**
   * Seconds an idle worker will wait to be woken, instead of polling.
   *
   * Off by default, as Laravel's `block_for` is. With it set, a worker with nothing
   * to do holds a `BLPOP` on the queue's notification list and starts the next job
   * the moment it is pushed, rather than up to `--sleep` seconds later. It costs a
   * connection held open per worker, which is why it is a choice rather than the
   * default.
   */
  blockFor?: number
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
  redis.call('lpop', KEYS[3])
end

return {job, reserved}
`

/**
 * Push a job, and a token saying one arrived.
 *
 * The token is what a blocked worker is waiting on. It has to be written in the
 * same step as the job: pushed afterwards, a worker could be woken by a token for
 * a job that is not there yet, and pushed before, a job could sit unannounced.
 */
const PUSH = `
redis.call('rpush', KEYS[1], ARGV[1])
redis.call('rpush', KEYS[2], 1)
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

    for _ = i, math.min(i+99, #val) do
      redis.call('rpush', KEYS[3], 1)
    end
  end
end

return #val
`

const CLEAR = `
local size = redis.call('llen', KEYS[1]) + redis.call('zcard', KEYS[2]) + redis.call('zcard', KEYS[3])
redis.call('del', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
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
  private readonly blockFor: number | undefined

  /**
   * A second connection, opened only for the blocking read.
   *
   * `BLPOP` holds the connection it runs on for as long as it waits. Sharing the
   * driver's client would mean a worker's idle wait stalling every `push`, `size`
   * and `pop` issued from the same process — including its own next one. Opened
   * lazily, so a driver that never blocks never opens it.
   */
  private waiter: RedisClient | undefined

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

  private readonly url: string
  private readonly clientOptions: ConstructorParameters<typeof RedisClient>[1]

  constructor(
    readonly connectionName: string,
    options: RedisQueueOptions = {}
  ) {
    this.prefix = options.prefix ?? 'queues:'
    this.defaultQueue = options.queue ?? 'default'
    this.retryAfter = options.retryAfter ?? 90
    this.migrateEvery = options.migrateEvery ?? 1
    this.blockFor = options.blockFor
    this.url = options.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
    this.clientOptions = options.client
    this.client = new RedisClient(this.url, this.clientOptions)
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
    const name = this.key(queue)

    await this.run(PUSH, ['2', name, `${name}:notify`, JSON.stringify(payload)])

    return payload.uuid
  }

  async later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    const name = this.key(queue)

    await this.client.send('ZADD', [
      `${name}:delayed`,
      String(this.availableAt(delay)),
      JSON.stringify(payload)
    ])

    // The sweep is what makes it visible, and the sweep pushes the notification.

    // Due within the sweep window, so the next pop has to look rather than wait.
    if (delay <= this.migrateEvery) this.sweepSoon(name)

    return payload.uuid
  }

  async pop(queue?: string): Promise<QueuedJob | null> {
    const name = queue ?? this.defaultQueue

    await this.migrate(name, false)

    const result = (await this.run(POP, [
      '3',
      this.key(name),
      `${this.key(name)}:reserved`,
      `${this.key(name)}:notify`,
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

    const cleared = await this.run(CLEAR, [
      '4',
      name,
      `${name}:delayed`,
      `${name}:reserved`,
      `${name}:notify`
    ])

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

    await this.run(MIGRATE, ['3', `${name}:delayed`, name, `${name}:notify`, now, '100'])
    await this.run(MIGRATE, ['3', `${name}:reserved`, name, `${name}:notify`, now, '100'])
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

  /**
   * Wait to be woken rather than polling — Laravel's `block_for`.
   *
   * `BLPOP` on the queue's notification list returns the moment a job is pushed or
   * a delayed one is swept back, so a worker starts it then instead of on its next
   * poll. Without `blockFor` this answers `false` and the worker sleeps as before.
   *
   * The token is put back. A `BLPOP` consumes it, but the job it announced is still
   * on the list and it is `pop` that takes the pair — so returning without
   * replacing it would leave the queue holding a job that nothing was told about.
   * Two workers woken by one token is harmless: the second finds nothing and waits
   * again, which is exactly what the return contract says can happen.
   */
  async waitForJob(queue?: string): Promise<boolean> {
    if (this.blockFor === undefined) return false

    const notify = `${this.key(queue)}:notify`
    const client = (this.waiter ??= new RedisClient(this.url, this.clientOptions))

    const woken = await client.send('BLPOP', [notify, String(this.blockFor)])

    if (woken !== null) await this.client.send('RPUSH', [notify, '1'])

    return true
  }

  disconnect(): void {
    this.client.close()
    this.waiter?.close()
    this.waiter = undefined
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
