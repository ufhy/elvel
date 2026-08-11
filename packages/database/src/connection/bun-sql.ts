import { isAbsolute, join } from 'node:path'
import type { EventDispatcher } from '@elysian/contracts'
import type { Grammar } from '../query/grammar.ts'
import { MariaDbGrammar, MySqlGrammar } from '../query/grammars/mysql.ts'
import { PostgresGrammar } from '../query/grammars/postgres.ts'
import { SQLiteGrammar } from '../query/grammars/sqlite.ts'
import { type Connection, QueryExecuted, type Row } from './connection.ts'

export type ConnectionConfig = {
  driver: 'sqlite' | 'mysql' | 'mariadb' | 'postgres'
  /** SQLite only: file path, or `:memory:`. Relative paths resolve from `basePath`. */
  database?: string
  /** Application root, so a relative sqlite path does not depend on the cwd. */
  basePath?: string
  url?: string
  host?: string
  port?: number
  username?: string
  password?: string
  /** Maximum pooled connections. Ignored by sqlite. */
  max?: number
  idleTimeout?: number
  connectionTimeout?: number
  /** SQLite only: enforce foreign keys, as Laravel does by default. */
  foreignKeys?: boolean
  [option: string]: unknown
}

function grammarFor(driver: ConnectionConfig['driver']): Grammar {
  switch (driver) {
    case 'sqlite':
      return new SQLiteGrammar()
    case 'mysql':
      return new MySqlGrammar()
    case 'mariadb':
      return new MariaDbGrammar()
    case 'postgres':
      return new PostgresGrammar()
    default: {
      const exhaustive: never = driver
      throw new Error(`Unsupported database driver [${exhaustive}].`)
    }
  }
}

/** Deadlock signatures worth retrying, as Laravel's DetectsConcurrencyErrors does. */
const CONCURRENCY_ERRORS = [
  'deadlock detected',
  'deadlock found',
  'database is locked',
  'could not serialize access',
  'lock wait timeout exceeded',
  'sqlite_busy'
]

function isConcurrencyError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

  return CONCURRENCY_ERRORS.some((needle) => message.includes(needle))
}

/**
 * A connection backed by Bun's native SQL client.
 *
 * Bun.SQL covers sqlite, postgres, mysql and mariadb with pooling, transactions
 * and savepoints, so there is no third-party driver in the data layer at all.
 * Queries go through `unsafe(sql, bindings)` because our grammar produces the
 * SQL text; the tagged-template form cannot express a dynamic clause list.
 */
export class BunSqlConnection implements Connection {
  readonly grammar: Grammar

  constructor(
    readonly name: string,
    private readonly sql: Bun.SQL,
    private readonly config: ConnectionConfig,
    private readonly dispatcher?: EventDispatcher
  ) {
    this.grammar = grammarFor(config.driver)
  }

  static async make(
    name: string,
    config: ConnectionConfig,
    dispatcher?: EventDispatcher
  ): Promise<BunSqlConnection> {
    const sql = new Bun.SQL(BunSqlConnection.optionsFor(config) as never)
    const connection = new BunSqlConnection(name, sql, config, dispatcher)

    // Laravel enables SQLite foreign keys by default; SQLite does not.
    if (config.driver === 'sqlite' && config.foreignKeys !== false) {
      await connection.unprepared('PRAGMA foreign_keys = ON')
    }

    return connection
  }

  private static optionsFor(config: ConnectionConfig): Record<string, unknown> {
    const shared = {
      max: config.max,
      idleTimeout: config.idleTimeout,
      connectionTimeout: config.connectionTimeout
    }

    if (config.driver === 'sqlite') {
      return {
        adapter: 'sqlite',
        filename: BunSqlConnection.sqlitePath(config),
        // Laravel expects `touch database/database.sqlite`; creating the file is
        // friendlier and still explicit, since the path is configured.
        create: true
      }
    }

    if (config.url) return { adapter: config.driver, url: config.url, ...shared }

    return {
      adapter: config.driver,
      hostname: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      ...shared
    }
  }

  /**
   * Resolve the sqlite file. A relative path is relative to the application, not
   * to whatever directory the process happens to be started from — running
   * `bun run playground migrate` from the repo root must hit the same file.
   */
  static sqlitePath(config: ConnectionConfig): string {
    const database = config.database ?? ':memory:'

    if (database === ':memory:' || database.startsWith('sqlite:') || isAbsolute(database)) {
      return database
    }

    return config.basePath ? join(config.basePath, database) : database
  }

  async select<T = Row>(sql: string, bindings: unknown[] = []): Promise<T[]> {
    return this.run(sql, bindings, async () => {
      const rows = await this.sql.unsafe(sql, bindings as never)

      // Bun returns an array-like with metadata attached; copy to a plain array
      // so callers can rely on `Array.isArray` and spread it safely.
      return [...(rows as unknown as Iterable<T>)]
    })
  }

  async affectingStatement(sql: string, bindings: unknown[] = []): Promise<number> {
    return this.run(sql, bindings, async () => {
      const result = (await this.sql.unsafe(sql, bindings as never)) as unknown as {
        affectedRows?: number | null
        count?: number | null
      }

      return result.affectedRows ?? result.count ?? 0
    })
  }

  async statement(sql: string, bindings: unknown[] = []): Promise<void> {
    await this.run(sql, bindings, async () => {
      await this.sql.unsafe(sql, bindings as never)
    })
  }

  async unprepared(sql: string): Promise<void> {
    await this.run(sql, [], async () => {
      await this.sql.unsafe(sql)
    })
  }

  async transaction<T>(callback: (tx: Connection) => Promise<T>, attempts = 1): Promise<T> {
    let lastError: unknown

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      try {
        return (await this.sql.begin(async (tx: unknown) => {
          const scoped = new BunSqlConnection(
            this.name,
            tx as Bun.SQL,
            this.config,
            this.dispatcher
          )

          return callback(scoped)
        })) as T
      } catch (error) {
        lastError = error

        // Only deadlocks are worth retrying; a constraint violation never is.
        if (attempt >= attempts || !isConcurrencyError(error)) throw error
      }
    }

    throw lastError
  }

  async disconnect(): Promise<void> {
    await this.sql.close()
  }

  /** Time every query and announce it, which is what makes a query log possible. */
  private async run<T>(sql: string, bindings: unknown[], execute: () => Promise<T>): Promise<T> {
    const started = Bun.nanoseconds()

    try {
      return await execute()
    } finally {
      const elapsed = Math.round((Bun.nanoseconds() - started) / 1_000) / 1_000

      void this.dispatcher?.dispatch(new QueryExecuted(sql, bindings, elapsed, this.name))
    }
  }
}
