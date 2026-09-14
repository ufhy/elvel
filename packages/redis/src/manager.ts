import type { ApplicationContract } from '@elvel/contracts'
import { type CommandDispatcher, type ConnectionOptions, RedisConnection } from './connection.ts'

/**
 * One connection per name, shared by everything that wants it.
 *
 * An application using cache, queue and broadcasting opened **at least four**
 * clients per process — broadcasting needs two of its own, because a client in
 * subscribe mode may issue nothing else — and every worker multiplied that.
 * Pointing them all at one server also meant saying so three times, in three
 * config files, with three environment variables that could drift apart.
 *
 * Memoised per name, so resolving `default` from three packages hands back one
 * connection rather than three.
 */
export class RedisManager {
  private readonly connections = new Map<string, RedisConnection>()

  constructor(private readonly app?: ApplicationContract) {}

  connection(name?: string): RedisConnection {
    const resolved = name ?? this.defaultConnection()
    const existing = this.connections.get(resolved)

    if (existing) return existing

    const built = new RedisConnection(resolved, this.configFor(resolved), this.dispatcher())

    this.connections.set(resolved, built)

    return built
  }

  defaultConnection(): string {
    return this.app?.config.get<string>('redis.default', 'default') ?? 'default'
  }

  /** Every name configured, for `redis:status` and for a test. */
  names(): string[] {
    const configured = this.app?.config.get<Record<string, unknown>>('redis.connections', {}) ?? {}

    return Object.keys(configured)
  }

  /** Register a connection built elsewhere — for a test, or a second server. */
  set(name: string, connection: RedisConnection): this {
    this.connections.set(name, connection)

    return this
  }

  /** Close everything this manager opened. Called on shutdown. */
  disconnect(): void {
    for (const connection of this.connections.values()) connection.disconnect()

    this.connections.clear()
  }

  private configFor(name: string): ConnectionOptions {
    const config =
      this.app?.config.get<Record<string, unknown> | undefined>(`redis.connections.${name}`) ??
      undefined

    if (config === undefined) {
      /**
       * An unconfigured name is an error, not a default.
       *
       * A typo would otherwise open a connection to localhost and fail somewhere
       * far from the name that was wrong.
       */
      if (name !== 'default') {
        throw new Error(`Redis connection [${name}] is not configured. Add it to config/redis.ts.`)
      }

      return { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' }
    }

    return {
      url: config.url as string | undefined,
      nodes: config.nodes as string[] | undefined,
      prefix: config.prefix as string | undefined,
      client: config.client as ConnectionOptions['client']
    }
  }

  private dispatcher(): CommandDispatcher | undefined {
    if (this.app === undefined || !this.app.bound('events' as never)) return undefined

    return this.app.make('events' as never) as CommandDispatcher
  }
}
