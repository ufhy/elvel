import { app } from '@elvel/core'
import type { Row } from './connection/connection.ts'
import type { QueryBuilder } from './query/builder.ts'
import type { SchemaBuilder } from './schema/builder.ts'

/**
 * The connection manager for the application.
 *
 * ```ts
 * const users = await db().table('users')
 * await users.where('active', 1).get()
 * ```
 */
export function db() {
  return app('db')
}

/** A query builder for a table on the default connection. */
export function table<T extends Row = Row>(name: string): Promise<QueryBuilder<T>> {
  return db().table<T>(name)
}

/** The schema builder. */
export function schema(connection?: string): Promise<SchemaBuilder> {
  return db().schema(connection)
}
