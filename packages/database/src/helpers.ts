import { app } from '@elvel/core'
import type { Row } from './connection/connection.ts'
import type { QueryBuilder } from './query/builder.ts'
import type { SchemaBuilder } from './schema/builder.ts'

/**
 * The connection manager — Laravel's `DB` facade.
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

/** The schema builder — Laravel's `Schema` facade. */
export function schema(connection?: string): Promise<SchemaBuilder> {
  return db().schema(connection)
}
