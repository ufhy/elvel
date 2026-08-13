import type { ApplicationContract, EventDispatcher } from '@elysian/contracts'
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
 * A list means "any of these replicas", and Laravel picks at random rather than
 * round-robin: with several processes, random spreads the load without any of
 * them having to agree on whose turn it is.
 */
function pickHost(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return {}

  if (Array.isArray(entry)) {
    if (entry.length === 0) return {}

    return entry[Math.floor(Math.random() * entry.length)] as Record<string, unknown>
  }

  return entry as Record<string, unknown>
}
