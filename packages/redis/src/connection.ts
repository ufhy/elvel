import { RedisClient } from 'bun'

/** A dispatcher, when one is registered. Redis works without events. */
export type CommandDispatcher = {
  dispatch(event: object | string, payload?: unknown): unknown
  hasListeners?(event: unknown): boolean
}

/**
 * One command, and how long it took.
 *
 * Nothing dispatched anything before, so a page whose slowest part was a Redis
 * call showed 400ms and could not say where any of it went. Cache entries cover
 * what goes through `@elvel/cache`; a broadcast publish, a queue pop, or
 * anything an application runs directly was invisible.
 */
export class CommandExecuted {
  static readonly eventName = 'redis.command'

  constructor(
    readonly command: string,
    readonly args: string[],
    /** Milliseconds, to three decimal places. */
    readonly duration: number,
    readonly connectionName: string
  ) {}
}

export class CommandFailed {
  static readonly eventName = 'redis.command.failed'

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly error: unknown,
    readonly connectionName: string
  ) {}
}

export type ConnectionOptions = {
  url?: string
  /**
   * Several URLs — a cluster.
   *
   * Bun's client speaks to one node, so this is a hash ring over clients rather
   * than cluster protocol support: a key is routed to the same node every time,
   * which is what a cache or a set of queues needs. It does **not** follow a
   * `MOVED` redirect, so a cluster that reshards while running needs a client
   * that speaks the protocol, and this says so rather than pretending.
   */
  nodes?: string[]
  prefix?: string
  client?: ConstructorParameters<typeof RedisClient>[1]
}

/**
 * A named Redis connection.
 *
 * Every command goes through `send`, which is what makes the timing event
 * possible at all — and why the three packages that used to build their own
 * clients now resolve one from here.
 */
export class RedisConnection {
  private readonly clients: RedisClient[]
  private readonly subscribers: RedisClient[] = []
  private timed: RedisClient | undefined

  constructor(
    readonly name: string,
    private readonly options: ConnectionOptions = {},
    private readonly dispatcher?: CommandDispatcher
  ) {
    const urls = options.nodes ?? [options.url ?? 'redis://127.0.0.1:6379']

    this.clients = urls.map((url) => new RedisClient(url, options.client))
  }

  /** The client a key belongs to. One node, or the ring's choice. */
  clientFor(key?: string): RedisClient {
    if (this.clients.length === 1 || key === undefined) return this.clients[0] as RedisClient

    return this.clients[hash(key) % this.clients.length] as RedisClient
  }

  /**
   * Run a command, timed.
   *
   * The event is built only when somebody is listening: a queue polling every
   * few milliseconds would otherwise allocate one per poll for nothing.
   */
  async send(command: string, args: string[] = []): Promise<unknown> {
    const client = this.clientFor(args[0])
    const watched =
      this.dispatcher !== undefined && this.dispatcher.hasListeners?.(CommandExecuted) !== false

    if (!watched) return await client.send(command, args)

    return (await this.timing(command, args, () => client.send(command, args))) as unknown
  }

  /**
   * A client of this connection's own, for a caller that must not share.
   *
   * A subscriber is the case: a client in subscribe mode may issue nothing
   * else, so broadcasting needs one that nobody else writes through. Tracked so
   * `disconnect()` closes them.
   */
  subscriber(): RedisClient {
    const client = new RedisClient(
      this.options.nodes?.[0] ?? this.options.url ?? 'redis://127.0.0.1:6379',
      this.options.client
    )

    this.subscribers.push(client)

    return client
  }

  /**
   * The underlying client, for a caller that needs Bun's own API.
   *
   * Timed when a dispatcher is registered, because the cache, the queue and the
   * broadcaster call `get`, `set` and `send` on the client itself — a page whose
   * slowest part was a cache read would otherwise still have nothing to show.
   * Without a dispatcher this is the client, and costs nothing.
   */
  get client(): RedisClient {
    const client = this.clients[0] as RedisClient

    if (this.dispatcher === undefined) return client

    this.timed ??= this.timeCommands(client)

    return this.timed
  }

  /** Wraps every command method in the timing the event needs. */
  private timeCommands(client: RedisClient): RedisClient {
    // Connection management, not commands: timing them would report a close as
    // a Redis call that took no time.
    const passthrough = new Set(['close', 'connect', 'duplicate', 'unref', 'ref'])

    return new Proxy(client, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target)

        if (typeof value !== 'function' || typeof property !== 'string') return value
        if (passthrough.has(property)) return (value as () => unknown).bind(target)

        return (...args: unknown[]) => {
          const command = property === 'send' ? String(args[0] ?? 'SEND') : property.toUpperCase()
          const parameters = (property === 'send' ? (args[1] ?? []) : args) as unknown[]

          return this.timing(command, parameters.map(String), () =>
            (value as (...given: unknown[]) => unknown).apply(target, args)
          )
        }
      }
    }) as RedisClient
  }

  /**
   * Run something, dispatching what it was and how long it took.
   *
   * A promise is awaited before the event is dispatched — a command's duration
   * is what the caller waited for, not what it took to hand off.
   */
  private timing(command: string, args: string[], run: () => unknown): unknown {
    const started = Bun.nanoseconds()
    const done = () => {
      const elapsed = Math.round((Bun.nanoseconds() - started) / 1_000) / 1_000

      void this.dispatcher?.dispatch(new CommandExecuted(command, args, elapsed, this.name))
    }

    const failed = (error: unknown) => {
      void this.dispatcher?.dispatch(new CommandFailed(command, args, error, this.name))
    }

    try {
      const answer = run()

      if (answer instanceof Promise) {
        return answer.then(
          (value) => {
            done()

            return value
          },
          (error: unknown) => {
            failed(error)
            done()

            throw error
          }
        )
      }

      done()

      return answer
    } catch (error) {
      failed(error)
      done()

      throw error
    }
  }

  prefix(): string {
    return this.options.prefix ?? ''
  }

  disconnect(): void {
    for (const client of [...this.clients, ...this.subscribers]) {
      try {
        client.close()
      } catch {
        // Already closed, or never opened. Nothing to close is the outcome asked
        // for either way.
      }
    }
  }
}

/**
 * FNV-1a, which is enough to spread keys evenly across a handful of nodes.
 *
 * Not the CRC16 a real cluster uses: this ring is ours, and two processes agree
 * because they run the same function — they are not talking to a cluster that
 * has an opinion about slots.
 */
function hash(key: string): number {
  let value = 2_166_136_261

  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index)
    value = Math.imul(value, 16_777_619)
  }

  return Math.abs(value)
}
