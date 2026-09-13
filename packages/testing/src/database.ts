import { fail, show } from './assert.ts'

/** Duck-typed: `@elvel/testing` has no dependencies, so the manager is passed in. */
export type TestConnection = {
  readonly name: string
  /** `name` is the config key, so only this tells us the placeholder style. */
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
  /** Build the schema. Runs once per process, outside the transaction. */
  migrate?: () => Promise<unknown>
}

/** Schema builds already run in this process, by connection name. */
const migrated = new Map<string, Promise<unknown>>()

/**
 * Wrap every test in a transaction and roll it back.
 *
 * ```ts
 * refreshDatabase(app.make('db'), { beforeEach, afterEach }, {
 *   migrate: () => migrator.run()
 * })
 * ```
 *
 * `transaction()` hands its callback a *different* connection object, so the
 * name is swapped to point at it — otherwise a handler resolving by name writes
 * outside the test's transaction and survives the rollback.
 */
export function refreshDatabase(
  manager: TestConnectionManager,
  hooks: Hooks,
  options: RefreshOptions = {}
): void {
  const name = options.connection ?? manager.getDefaultConnection()

  // `transaction()` owns its callback, but the test body is not known until
  // `beforeEach` returns — so it is opened here and held until `afterEach`.
  let release: (() => void) | undefined
  let rollback: (() => void) | undefined
  let finished: Promise<unknown> | undefined

  hooks.beforeEach(async () => {
    if (options.migrate) {
      // Awaited by every test, not only the first: two files must not race the
      // same `create table`.
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

    // Throwing out of the callback is the only way to roll back: the contract
    // has `transaction(callback)` and no `rollBack()`.
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

/** Private, so a real failure in the test is never mistaken for the signal. */
const ROLLBACK = Symbol('elvel:testing:rollback')

/** Forget that the schema was built, for a suite that changes it. */
export function forgetMigrations(): void {
  migrated.clear()
}

/** `where` as a plain object — the shape every assertion below takes. */
export type Attributes = Record<string, unknown>

/** Assert a row exists. The failure lists what the table does hold. */
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

/** Assert no row matches. */
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

/** Assert a row is present with its delete column set. */
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

/** What the table does hold, for a failure message. Five rows at most. */
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

/** Quote an identifier — MySQL uses backticks, everything else double quotes. */
function quote(identifier: string, connection: TestConnection): string {
  if (identifier.includes('"') || identifier.includes('`')) {
    throw new Error(`Refusing to quote the identifier [${identifier}]: it contains a quote.`)
  }

  return isMysql(connection) ? `\`${identifier}\`` : `"${identifier}"`
}

/** The grammar's dialect. The name is a fallback only a hand-written double hits. */
function dialectOf(connection: TestConnection): string {
  return connection.grammar?.dialect ?? connection.name
}

function isPostgres(connection: TestConnection): boolean {
  return /postgres|pgsql/i.test(dialectOf(connection))
}

function isMysql(connection: TestConnection): boolean {
  return /mysql|mariadb/i.test(dialectOf(connection))
}
