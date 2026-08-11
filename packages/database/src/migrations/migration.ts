import type { Connection } from '../connection/connection.ts'
import type { SchemaBuilder } from '../schema/builder.ts'

export type MigrationContext = {
  schema: SchemaBuilder
  connection: Connection
}

/**
 * Base class for migrations.
 *
 * `up()`/`down()` are both required: a migrator that cannot roll back is a
 * one-way door, which is exactly why `drizzle-kit` was not used for this.
 */
export abstract class Migration {
  /** Wrap this migration in a transaction where the dialect supports DDL in one. */
  static readonly withinTransaction: boolean = true

  /** Name of the connection this migration runs against, if not the default. */
  static readonly connection: string | undefined

  abstract up(context: MigrationContext): Promise<void> | void

  abstract down(context: MigrationContext): Promise<void> | void

  /** Return false to skip this migration for now — Laravel's `shouldRun`. */
  shouldRun(): boolean {
    return true
  }
}

export type MigrationFile = {
  /** File name without extension, e.g. `2026_08_11_120000_create_users_table`. */
  name: string
  path: string
  migration: Migration
  withinTransaction: boolean
  connection?: string
}
