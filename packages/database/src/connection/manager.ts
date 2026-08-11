import type { ApplicationContract, EventDispatcher } from '@elysian/contracts'
import { QueryBuilder } from '../query/builder.ts'
import { SchemaBuilder } from '../schema/builder.ts'
import { BunSqlConnection, type ConnectionConfig } from './bun-sql.ts'
import type { Connection, Row } from './connection.ts'

/**
 * Resolves and caches connections — Laravel's `DatabaseManager`, and the object
 * behind the `db()` helper.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>()

  constructor(private readonly app: ApplicationContract) {}

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

    const connection = await BunSqlConnection.make(
      resolved,
      // Give the driver the application root so relative sqlite paths resolve
      // the same way regardless of the working directory.
      { basePath: this.app.basePath(), ...config },
      this.dispatcher()
    )
    this.connections.set(resolved, connection)

    return connection
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
