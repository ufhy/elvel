import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, join } from 'node:path'
import type { EventDispatcher } from '@elysian/contracts'
import type { Grammar } from '../query/grammar.ts'
import { MariaDbGrammar, MySqlGrammar } from '../query/grammars/mysql.ts'
import { PostgresGrammar } from '../query/grammars/postgres.ts'
import { SQLiteGrammar } from '../query/grammars/sqlite.ts'
import { type Connection, QueryExecuted, type Row } from './connection.ts'
import { TransactionManager } from './transactions.ts'

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
/**
 * The transactions open in the current async context, by connection name.
 *
 * `run()` rather than `enterWith()`: the store has to be visible to everything the
 * callback awaits and invisible to everything outside it, which is what makes two
 * concurrent transactions independent.
 */
const openTransactions = new AsyncLocalStorage<ReadonlyMap<string, TransactionManager>>()

export class BunSqlConnection implements Connection {
  readonly grammar: Grammar

  constructor(
    readonly name: string,
    private readonly sql: Bun.SQL,
    private readonly config: ConnectionConfig,
    private readonly dispatcher?: EventDispatcher,
    /**
     * The transaction this connection *is* inside, if it is a scoped copy.
     *
     * A shared counter on the pool cannot work: two `transaction()` calls that run
     * concurrently — which is exactly what the queue's two-worker race does — are
     * siblings, not one nested in the other, and Bun hands each its own connection
     * from the pool. So being inside a transaction is a property of this object,
     * and only the copy handed to a callback has it.
     */
    private readonly scope?: TransactionManager
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

  /** The transaction this connection is inside, if any. */
  get transactions(): TransactionManager | undefined {
    return this.scope ?? openTransactions.getStore()?.get(this.name)
  }

  /**
   * Run `callback` once the outermost transaction on this connection commits.
   *
   * Outside a transaction it runs now, which is what lets a caller defer work
   * unconditionally: "after the commit, if there is one" is almost always what is
   * meant, and code usually cannot answer whether its caller opened one.
   *
   * The open transaction is found in async context, not on this object, because
   * the caller that needs this most does not hold one. A queued listener is pushed
   * by the event dispatcher, which has the application's connection and no idea a
   * service method three frames up opened a transaction — and that is exactly the
   * case `afterCommit` exists for.
   */
  async afterCommit(callback: () => unknown): Promise<void> {
    const manager = this.transactions

    if (!manager) {
      await callback()

      return
    }

    await manager.afterCommit(callback)
  }

  async transaction<T>(callback: (tx: Connection) => Promise<T>, attempts = 1): Promise<T> {
    let lastError: unknown

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      /**
       * Nested only when this object *is* an open transaction's own copy.
       *
       * Two `transaction()` calls on the pool that overlap in time — which is what
       * the queue's two-worker race does — are siblings, and Bun hands each its own
       * connection. Only the copy passed to a callback holds a transaction that a
       * savepoint can be taken on.
       */
      const nested = this.scope !== undefined
      const manager = nested ? (this.scope as TransactionManager) : new TransactionManager()

      manager.begin()

      /** What the async context sees while the body runs: one manager per name. */
      const scopes = new Map(openTransactions.getStore() ?? [])
      scopes.set(this.name, manager)

      try {
        /**
         * A transaction inside a transaction is a savepoint.
         *
         * Bun.SQL refuses a nested `begin` outright — "cannot call begin inside a
         * transaction use savepoint() instead" — and it is right to: `BEGIN` twice
         * is not two transactions in any engine we target. Nesting is what lets a
         * service method wrap its own work in `transaction()` without caring
         * whether its caller already opened one, which is what Laravel's
         * transaction level gives.
         */
        const open = nested
          ? (body: (tx: unknown) => Promise<unknown>) =>
              (
                this.sql as unknown as { savepoint(fn: (tx: unknown) => Promise<unknown>): unknown }
              ).savepoint(body)
          : (body: (tx: unknown) => Promise<unknown>) => this.sql.begin(body as never)

        const result = (await openTransactions.run(scopes, () =>
          open(async (tx: unknown) => {
            const scoped = new BunSqlConnection(
              this.name,
              tx as Bun.SQL,
              this.config,
              this.dispatcher,
              // The manager for *this* transaction: work deferred through `tx` is
              // released by the commit this call is about, and by no other.
              manager
            )

            return callback(scoped)
          })
        )) as T

        // After the transaction resolves, and only then: the callbacks exist to
        // run against committed rows.
        await manager.commit()

        return result
      } catch (error) {
        manager.rollback()

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
