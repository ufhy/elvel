import { fail, show } from './assert.ts'

/**
 * The database, as this package is allowed to see it.
 *
 * Duck-typed rather than imported. `@elvel/testing` has no dependencies on
 * purpose — the same reason `elvel()` takes `Output.prototype` from its caller —
 * so the manager arrives as an argument and this file never names
 * `@elvel/database`.
 */
export type TestConnection = {
  readonly name: string
  /**
   * Optional, and the only reliable way to know the dialect: `name` is the
   * config key, so a Postgres connection an application called `main` says
   * nothing about its placeholders.
   */
  readonly grammar?: { readonly dialect?: string }
  select<T = Record<string, unknown>>(sql: string, bindings?: unknown[]): Promise<T[]>
  transaction<T>(callback: (tx: TestConnection) => Promise<T>): Promise<T>
}

export type TestConnectionManager = {
  getDefaultConnection(): string
  connection(name?: string): Promise<TestConnection>
  /** Answer `name` with this connection until the returned callback is called. */
  swap(name: string, connection: TestConnection): () => void
}

/** The two hooks a runner supplies. `bun:test` satisfies this as it stands. */
export type Hooks = {
  beforeEach(callback: () => Promise<void> | void): unknown
  afterEach(callback: () => Promise<void> | void): unknown
}

export type RefreshOptions = {
  /** The connection to wrap. The default one when this is absent. */
  connection?: string
  /**
   * Build the schema. Runs **once per process**, before the first test, outside
   * the transaction — a rolled-back `create table` would leave nothing behind.
   */
  migrate?: () => Promise<unknown>
}

/** Schema builds already run in this process, by connection name. */
const migrated = new Map<string, Promise<unknown>>()

/**
 * Wrap every test in a transaction and roll it back — Laravel's
 * `RefreshDatabase`.
 *
 * ```ts
 * import { beforeEach, afterEach } from 'bun:test'
 * import { refreshDatabase } from '@elvel/testing'
 *
 * refreshDatabase(app.make('db'), { beforeEach, afterEach }, {
 *   migrate: () => migrator.run()
 * })
 * ```
 *
 * The transaction is what makes a suite independent: nothing a test writes
 * survives it, so tests stop depending on the order they happen to run in and
 * on what the one before them left behind.
 *
 * **The swap is the part that makes it work.** `transaction()` hands its
 * callback a *different* connection object — carrying the open transaction is a
 * property of the object, never of the pool — so a handler resolving the
 * connection by name would get the pooled one, write outside the test's
 * transaction, and survive the rollback. `swap()` points the name at the
 * transaction's object for the duration.
 *
 * Reads need no special handling: a connection inside a transaction already
 * sends them to the primary, because a replica cannot see uncommitted rows.
 */
export function refreshDatabase(
  manager: TestConnectionManager,
  hooks: Hooks,
  options: RefreshOptions = {}
): void {
  const name = options.connection ?? manager.getDefaultConnection()

  /**
   * `transaction()` owns the whole test, so the test body has to run inside its
   * callback — and the body is not known until `beforeEach` has returned. The
   * transaction is therefore opened here and held with these two, and released
   * by `afterEach`.
   */
  let release: (() => void) | undefined
  let rollback: (() => void) | undefined
  let finished: Promise<unknown> | undefined

  hooks.beforeEach(async () => {
    if (options.migrate) {
      // Once per process, and awaited by every test rather than only the first:
      // two test files importing this must not race the same `create table`.
      let build = migrated.get(name)

      if (!build) {
        build = options.migrate()
        migrated.set(name, build)
      }

      await build
    }

    const connection = await manager.connection(name)

    let opened: (tx: TestConnection) => void = () => undefined
    const ready = new Promise<TestConnection>((resolve) => {
      opened = resolve
    })

    /**
     * Rejected on purpose at the end of the test: throwing out of the callback
     * is what tells the connection to roll back, and there is no other way in —
     * the contract has `transaction(callback)` and no `rollBack()`.
     *
     * The rejection is swallowed by the `catch` below rather than becoming an
     * unhandled rejection, and it is a private symbol so a real failure inside
     * the test is never mistaken for it.
     */
    finished = connection
      .transaction(async (tx) => {
        opened(tx)

        await new Promise<void>((_resolve, reject) => {
          rollback = () => reject(ROLLBACK)
        })
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error
      })

    release = manager.swap(name, await ready)
  })

  hooks.afterEach(async () => {
    rollback?.()

    try {
      await finished
    } finally {
      release?.()
      release = undefined
      rollback = undefined
      finished = undefined
    }
  })
}

/** Not an `Error`: nothing should ever report it, and nothing should catch it. */
const ROLLBACK = Symbol('elvel:testing:rollback')

/**
 * Forget that the schema was built. For a suite that changes it deliberately.
 */
export function forgetMigrations(): void {
  migrated.clear()
}

/** `where` as a plain object — the shape every assertion below takes. */
export type Attributes = Record<string, unknown>

/**
 * Assert a row exists — Laravel's `assertDatabaseHas`.
 *
 * The failure message carries the rows that *are* in the table, capped, because
 * "no matching row" on its own sends you to a database client to find out
 * whether the table is empty or the value merely differs.
 */
export async function assertDatabaseHas(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  connection?: string
): Promise<void> {
  const found = await countMatching(manager, table, attributes, connection)

  if (found > 0) return

  fail(
    `Expected a row in [${table}] matching ${show(attributes)}, and found none.\n` +
      (await nearby(manager, table, connection)),
    attributes,
    null
  )
}

/** Assert no row matches — Laravel's `assertDatabaseMissing`. */
export async function assertDatabaseMissing(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  connection?: string
): Promise<void> {
  const found = await countMatching(manager, table, attributes, connection)

  if (found === 0) return

  fail(
    `Expected no row in [${table}] matching ${show(attributes)}, and found ${found}.`,
    null,
    attributes
  )
}

/** Assert how many rows a table holds, optionally narrowed. */
export async function assertDatabaseCount(
  manager: TestConnectionManager,
  table: string,
  expected: number,
  attributes: Attributes = {},
  connection?: string
): Promise<void> {
  const found = await countMatching(manager, table, attributes, connection)

  if (found === expected) return

  const narrowed = Object.keys(attributes).length > 0 ? ` matching ${show(attributes)}` : ''

  fail(`Expected ${expected} row(s) in [${table}]${narrowed}, and found ${found}.`, expected, found)
}

/**
 * Assert a row is soft-deleted: present, with its delete column set.
 *
 * The column is a parameter because a model may rename it, and this package
 * cannot ask the model — it has no access to one.
 */
export async function assertSoftDeleted(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  column = 'deleted_at',
  connection?: string
): Promise<void> {
  const rows = await matching(manager, table, attributes, connection)

  if (rows.length === 0) {
    fail(
      `Expected a soft-deleted row in [${table}] matching ${show(attributes)}, and found no row at all.\n` +
        (await nearby(manager, table, connection)),
      attributes,
      null
    )
  }

  if (rows.some((row) => row[column] !== null && row[column] !== undefined)) return

  fail(
    `Expected [${table}] row matching ${show(attributes)} to have [${column}] set, and it is null.`,
    attributes,
    rows[0]
  )
}

/** The mirror: the row is there and has not been soft-deleted. */
export async function assertNotSoftDeleted(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  column = 'deleted_at',
  connection?: string
): Promise<void> {
  const rows = await matching(manager, table, attributes, connection)

  if (rows.length === 0) {
    fail(
      `Expected a row in [${table}] matching ${show(attributes)}, and found none.\n` +
        (await nearby(manager, table, connection)),
      attributes,
      null
    )
  }

  if (rows.some((row) => row[column] === null || row[column] === undefined)) return

  fail(
    `Expected [${table}] row matching ${show(attributes)} not to be soft-deleted, and [${column}] is set.`,
    attributes,
    rows[0]
  )
}

/** Rows matching every attribute. `null` is compared with `is null`. */
async function matching(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  connection?: string
): Promise<Array<Record<string, unknown>>> {
  const held = await manager.connection(connection)
  const { clause, bindings } = whereFor(attributes, held)

  return held.select(`select * from ${quote(table, held)}${clause}`, bindings)
}

async function countMatching(
  manager: TestConnectionManager,
  table: string,
  attributes: Attributes,
  connection?: string
): Promise<number> {
  return (await matching(manager, table, attributes, connection)).length
}

/**
 * What the table does hold, for a failure message. Capped at five rows.
 *
 * A failed assertion that also says the table is empty has told you the answer;
 * one that lists three rows with a different `status` has told you the answer
 * too.
 */
async function nearby(
  manager: TestConnectionManager,
  table: string,
  connection?: string
): Promise<string> {
  try {
    const held = await manager.connection(connection)
    const rows = await held.select(`select * from ${quote(table, held)} limit 5`)

    if (rows.length === 0) return `[${table}] is empty.`

    return `[${table}] holds:\n${rows.map((row) => `  ${show(row)}`).join('\n')}`
  } catch (error) {
    // The table may not exist, which is itself the answer.
    return `[${table}] could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
}

function whereFor(
  attributes: Attributes,
  connection: TestConnection
): { clause: string; bindings: unknown[] } {
  const entries = Object.entries(attributes)

  if (entries.length === 0) return { clause: '', bindings: [] }

  const bindings: unknown[] = []
  const parts = entries.map(([column, value]) => {
    if (value === null) return `${quote(column, connection)} is null`

    bindings.push(value)

    return `${quote(column, connection)} = ${placeholder(connection, bindings.length)}`
  })

  return { clause: ` where ${parts.join(' and ')}`, bindings }
}

/** Postgres numbers its placeholders; the others use `?`. */
function placeholder(connection: TestConnection, position: number): string {
  return isPostgres(connection) ? `$${position}` : '?'
}

/**
 * Quote an identifier, so a column called `order` or `to` is not a syntax
 * error. MySQL uses backticks; everything else uses double quotes.
 */
function quote(identifier: string, connection: TestConnection): string {
  if (identifier.includes('"') || identifier.includes('`')) {
    throw new Error(`Refusing to quote the identifier [${identifier}]: it contains a quote.`)
  }

  return isMysql(connection) ? `\`${identifier}\`` : `"${identifier}"`
}

/**
 * The dialect, from the grammar when there is one and from the connection name
 * otherwise.
 *
 * The fallback is a guess and is only reached by a hand-written double: a real
 * connection carries its grammar, and an application is free to name a Postgres
 * connection `main`.
 */
function dialectOf(connection: TestConnection): string {
  return connection.grammar?.dialect ?? connection.name
}

function isPostgres(connection: TestConnection): boolean {
  return /postgres|pgsql/i.test(dialectOf(connection))
}

function isMysql(connection: TestConnection): boolean {
  return /mysql|mariadb/i.test(dialectOf(connection))
}
