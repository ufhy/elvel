import type { ApplicationContract, EventDispatcher } from '@elyvel/contracts'
import { QueryBuilder } from '../query/builder.ts'
import { SchemaBuilder } from '../schema/builder.ts'
import { BunSqlConnection, type ConnectionConfig } from './bun-sql.ts'
import { type Connection, QueryExecuted, type Row } from './connection.ts'
import { ReadWriteConnection } from './read-write.ts'

/**
 * Resolves and caches connections — Laravel's `DatabaseManager`, and the object
 * behind the `db()` helper.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>()

  constructor(private readonly app: ApplicationContract) {}

  /**
   * Run `callback` for every executed query — `DB::listen`.
   *
   * Sugar over the `db.query` event, which every connection already dispatches:
   * this exists so "log slow queries" is one call rather than a subscription to a
   * name the caller has to know.
   */
  listen(callback: (query: QueryExecuted) => unknown): void {
    if (!this.app.bound('events')) {
      throw new Error('DB.listen needs the event dispatcher. Register EventServiceProvider.')
    }

    ;(
      this.app.make('events' as never) as {
        listen(event: string, listener: (payload: unknown) => unknown): void
      }
    ).listen(QueryExecuted.eventName, (payload) => callback(payload as QueryExecuted))
  }

  getDefaultConnection(): string {
    return this.app.config.get<string>('database.default', 'sqlite')
  }

  setDefaultConnection(name: string): void {
    this.app.config.set('database.default', name)
  }

  /** Resolve a connection, opening it on first use. */
  async connection(name?: string): Promise<Connection> {
    const resolved = name ?? this.getDefaultConnection()
    const cached = this.connections.get(resolved)
    if (cached) return cached

    const config = this.app.config.get<ConnectionConfig | undefined>(
      `database.connections.${resolved}`
    )

    if (!config) {
      throw new Error(
        `Database connection [${resolved}] is not configured. Add it to config/database.ts.`
      )
    }

    const connection = await this.make(resolved, config)

    this.connections.set(resolved, connection)

    return connection
  }

  /**
   * Build one connection, or a read/write pair when the config names both.
   *
   * `read` and `write` are merged *over* the shared keys and then removed, which
   * is Laravel's `mergeReadWriteConfig`: one entry describes the credentials once
   * and only the host differs.
   */
  private async make(name: string, config: ConnectionConfig): Promise<Connection> {
    const shared = { basePath: this.app.basePath(), ...config } as ConnectionConfig &
      Record<string, unknown>

    const read = (shared as { read?: unknown }).read
    const write = (shared as { write?: unknown }).write

    if (!read && !write) return BunSqlConnection.make(name, shared, this.dispatcher())

    const sticky = (shared as { sticky?: boolean }).sticky === true
    const base = { ...shared }
    delete (base as Record<string, unknown>).read
    delete (base as Record<string, unknown>).write
    delete (base as Record<string, unknown>).sticky

    const writer = await BunSqlConnection.make(
      name,
      { ...base, ...pickHost(write) } as ConnectionConfig,
      this.dispatcher()
    )

    // A missing `read` means "reads go to the writer": the pair still exists, so
    // adding a replica later is a config change and not a code change.
    if (!read) return writer

    const reader = await BunSqlConnection.make(
      name,
      { ...base, ...pickHost(read) } as ConnectionConfig,
      this.dispatcher()
    )

    return new ReadWriteConnection(writer, reader, sticky)
  }

  /** A query builder on the default connection: `(await db()).table('users')`. */
  async table<T extends Row = Row>(table: string, name?: string): Promise<QueryBuilder<T>> {
    return new QueryBuilder<T>(await this.connection(name), table)
  }

  async schema(name?: string): Promise<SchemaBuilder> {
    return new SchemaBuilder(await this.connection(name))
  }

  async disconnect(name?: string): Promise<void> {
    const resolved = name ?? this.getDefaultConnection()
    const connection = this.connections.get(resolved)
    if (!connection) return

    await connection.disconnect()
    this.connections.delete(resolved)
  }

  /**
   * One transaction across several connections — two-phase commit.
   *
   * The problem it solves: two databases that must agree. Writing to each in its
   * own transaction leaves a window where the first has committed and the second
   * has not, and a crash in that window is a pair of databases that disagree for
   * ever with nothing to notice it.
   *
   * Both phases, in order. Each connection runs its part and *prepares* — the
   * work is durable but invisible. Only once every one of them has prepared does
   * anything commit. A failure before that point rolls all of them back.
   *
   * What it cannot promise is the window between the first commit and the last.
   * That window is microseconds rather than the duration of the work, and closing
   * it entirely needs a transaction manager with a recovery log — which is what
   * "we do not need distributed transactions" usually means in practice. A commit
   * that fails after another has succeeded is reported with the prepared
   * transaction's name, because that name is how an operator finishes it by hand.
   */
  async transactionAcross<T>(
    names: string[],
    callback: (connections: Record<string, Connection>) => Promise<T>
  ): Promise<T> {
    if (names.length === 0) throw new Error('transactionAcross() needs at least one connection.')

    // One identifier for the whole thing, shared by every participant: that is
    // what makes an interrupted commit recognisable in `pg_prepared_xacts` or
    // `XA RECOVER` as belonging to the same piece of work.
    const identifier = `elyvel_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`
    const participants: Array<{ name: string; connection: DistributedConnection }> = []

    for (const name of names) {
      const connection = await this.connection(name)

      if (!supportsTwoPhase(connection)) {
        throw new Error(
          `Connection [${name}] does not support two-phase commit, so it cannot join a transaction across connections.`
        )
      }

      participants.push({ name, connection })
    }

    /**
     * A name per participant, sharing one prefix.
     *
     * Not one name for all of them: two connections often point at the same
     * server — a second database on the same Postgres — and that server refuses
     * a duplicate identifier outright (`XAER_DUPID` on MySQL). The shared prefix
     * is what still makes them recognisable as one piece of work.
     */
    const nameFor = (participant: string) => `${identifier}_${participant}`

    const prepared: Array<{ name: string; connection: DistributedConnection }> = []
    const scoped: Record<string, Connection> = {}
    let result!: T

    /**
     * Every participant's transaction has to be open while the callback runs.
     *
     * Bun scopes a distributed transaction to a callback, so they are nested:
     * prepare the first, and inside it prepare the second, and inside the last
     * run the caller's work. Preparing them one after another instead would
     * finish the first before the callback had written anything to it — which is
     * exactly what the first draft did, and it prepared an empty transaction.
     */
    const open = async (remaining: typeof participants): Promise<void> => {
      const [next, ...rest] = remaining

      if (!next) {
        result = await callback(scoped)

        return
      }

      await next.connection.prepareDistributed(nameFor(next.name), async (tx) => {
        scoped[next.name] = tx

        await open(rest)
      })

      // Reached only once this participant has prepared successfully.
      prepared.push(next)
    }

    try {
      await open(participants)
    } catch (error) {
      for (const participant of prepared) {
        try {
          await participant.connection.rollbackDistributed(nameFor(participant.name))
        } catch {
          // Reported nowhere: the caller's error is the one worth raising, and a
          // rollback that fails leaves a prepared transaction the operator will
          // find by name.
        }
      }

      throw error
    }

    const committed: string[] = []

    for (const participant of prepared) {
      try {
        await participant.connection.commitDistributed(nameFor(participant.name))
        committed.push(participant.name)
      } catch (error) {
        throw new Error(
          `Distributed transaction [${identifier}] committed on [${committed.join(', ') || 'none'}] but failed on [${participant.name}]: ${error instanceof Error ? error.message : String(error)}. Finish it by hand — the prepared name is ${nameFor(participant.name)}.`
        )
      }
    }

    return result
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) await this.disconnect(name)
  }

  getConnections(): Map<string, Connection> {
    return new Map(this.connections)
  }

  private dispatcher(): EventDispatcher | undefined {
    // Optional: the database must work even without the events package.
    return this.app.bound('events')
      ? (this.app.make('events' as never) as EventDispatcher)
      : undefined
  }
}

/**
 * One host from a `read`/`write` entry.
 *
 * A list means "any of these replicas". Laravel picks uniformly at random, and
 * so does this by default — with several processes, random spreads the load
 * without any of them having to agree on whose turn it is.
 *
 * A host may also carry a `weight`, which is the case random alone handles
 * badly: replicas are rarely identical, and sending a third of the traffic to
 * the small one is how the small one becomes the bottleneck. Weights are
 * relative, so `{ weight: 3 }` beside `{ weight: 1 }` takes three quarters.
 */
export function pickHost(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return {}

  if (!Array.isArray(entry)) return entry as Record<string, unknown>

  if (entry.length === 0) return {}

  const hosts = entry as Array<Record<string, unknown>>
  const weights = hosts.map((host) => {
    const weight = Number(host.weight ?? 1)

    // A zero or negative weight means "not in the rotation" — the way to drain a
    // replica before taking it out of the config entirely.
    return Number.isFinite(weight) && weight > 0 ? weight : 0
  })

  const total = weights.reduce((sum, weight) => sum + weight, 0)

  // Every host drained: fall back to uniform rather than never reading, because
  // a config that excludes everything is a mistake and an outage is worse.
  if (total === 0) return hosts[Math.floor(Math.random() * hosts.length)] as Record<string, unknown>

  let ticket = Math.random() * total

  for (const [index, weight] of weights.entries()) {
    ticket -= weight

    if (ticket < 0) return hosts[index] as Record<string, unknown>
  }

  return hosts[hosts.length - 1] as Record<string, unknown>
}

/** A connection that can take part in two-phase commit. */
type DistributedConnection = Connection & {
  prepareDistributed<T>(name: string, callback: (tx: Connection) => Promise<T>): Promise<T>
  commitDistributed(name: string): Promise<void>
  rollbackDistributed(name: string): Promise<void>
}

function supportsTwoPhase(connection: Connection): connection is DistributedConnection {
  return typeof (connection as DistributedConnection).prepareDistributed === 'function'
}
