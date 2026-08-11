import type { Grammar } from '../query/grammar.ts'

export type Row = Record<string, unknown>

/**
 * What the query builder, schema builder and migrator need from a database.
 *
 * Bun.SQL is the only implementation today. Keeping it behind this interface is
 * what makes a Node driver (`pg`, `mysql2`, `node:sqlite`) an added file rather
 * than a rewrite — the same containment already used for views and log drivers.
 */
export interface Connection {
  readonly name: string
  readonly grammar: Grammar

  /** Run a query and return its rows. */
  select<T = Row>(sql: string, bindings?: unknown[]): Promise<T[]>

  /** Run a statement and return how many rows it affected. */
  affectingStatement(sql: string, bindings?: unknown[]): Promise<number>

  /** Run a statement whose result does not matter (DDL, pragmas). */
  statement(sql: string, bindings?: unknown[]): Promise<void>

  /** Run SQL with no bindings at all. Never pass user input here. */
  unprepared(sql: string): Promise<void>

  /**
   * Run `callback` inside a transaction, retrying on deadlock up to `attempts`.
   * The callback receives a connection scoped to the transaction.
   */
  transaction<T>(callback: (tx: Connection) => Promise<T>, attempts?: number): Promise<T>

  disconnect(): Promise<void>
}

/** Emitted after every query, mirroring Laravel's `QueryExecuted`. */
export class QueryExecuted {
  static readonly eventName = 'db.query'

  constructor(
    readonly sql: string,
    readonly bindings: unknown[],
    /** Milliseconds, with microsecond resolution. */
    readonly time: number,
    readonly connectionName: string
  ) {}
}
