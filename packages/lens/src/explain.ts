/**
 * Asking the database how it answered a query.
 *
 * This is the one thing in Lens that *acts* rather than watches: it issues a
 * statement of its own, on the connection the query just used. That is why it
 * is off by default, why it only ever runs plain `EXPLAIN` — never `ANALYZE`,
 * which executes the statement a second time — and why it only asks about a
 * `select` that was already slow enough to be worth a round trip.
 */

export type Plan = {
  /** Tables the database said it would read in full. */
  scans: string[]
  /** The plan as the server described it, trimmed for a panel. */
  detail: string
}

/** `explain` for the dialect, or nothing where asking is not safe. */
export function explainFor(dialect: string, sql: string): string | undefined {
  if (!isPlainSelect(sql)) return undefined

  switch (dialect) {
    case 'sqlite':
      return `explain query plan ${sql}`
    case 'postgres':
      // Never `ANALYZE`: that runs the statement, which for a `select` inside a
      // transaction is a second read and for anything else would be a write.
      return `explain (format json) ${sql}`
    case 'mysql':
    case 'mariadb':
      return `explain format=json ${sql}`
    default:
      return undefined
  }
}

/**
 * Only a select, and only one.
 *
 * A write is never explained — the cost is real and the answer is rarely the
 * question — and a statement carrying a second one after a semicolon is refused
 * rather than reasoned about.
 */
function isPlainSelect(sql: string): boolean {
  const trimmed = sql.trim()

  if (!/^select\b/i.test(trimmed)) return false

  return !trimmed.slice(0, -1).includes(';')
}

/** What the server said, read the way that server says it. */
export function readPlan(dialect: string, rows: Array<Record<string, unknown>>): Plan {
  if (dialect === 'sqlite') return fromSqlite(rows)

  const answer = rows[0] === undefined ? undefined : Object.values(rows[0])[0]

  /**
   * Parsed or not, depending on the driver.
   *
   * Postgres hands back the plan already decoded into objects; MySQL hands back
   * the JSON as a string. Measured against both rather than assumed, which is
   * how the first version of this came to read `[object Object]`.
   */
  const tree = typeof answer === 'string' ? parse(answer) : answer

  if (tree === undefined) return { scans: [], detail: '' }

  const scans = dialect === 'postgres' ? postgresScans(tree) : mysqlScans(tree)

  return { scans: [...new Set(scans)], detail: JSON.stringify(tree, null, 2).slice(0, 4000) }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Not JSON after all — an older server, or one answering in its own format.
    return undefined
  }
}

/** Every object in a plan, however deeply the server nested it. */
function* nodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item)

    return
  }

  if (value === null || typeof value !== 'object') return

  const node = value as Record<string, unknown>

  yield node

  for (const child of Object.values(node)) yield* nodes(child)
}

/** Postgres names the node type and the relation it read. */
function postgresScans(tree: unknown): string[] {
  const found: string[] = []

  for (const node of nodes(tree)) {
    if (node['Node Type'] !== 'Seq Scan') continue

    const relation = node['Relation Name']

    if (typeof relation === 'string') found.push(relation)
  }

  return found
}

/**
 * MySQL names the access type per table, and renamed it along the way.
 *
 * `"access_type": "ALL"` is the classic spelling; 8.4 answers `"table"` beside
 * an `"operation": "Table scan on …"`. Both are accepted, because which one a
 * server uses is not something an application should have to know.
 */
function mysqlScans(tree: unknown): string[] {
  const found: string[] = []

  for (const node of nodes(tree)) {
    const access = String(node.access_type ?? '')
    const operation = String(node.operation ?? '')
    const table = node.table_name

    if (typeof table !== 'string') continue
    if (access !== 'ALL' && access !== 'table' && !/^table scan on/i.test(operation)) continue
    // An indexed read is named as such, whatever the access type says.
    if (/^(index lookup|single-row index lookup|covering index)/i.test(operation)) continue

    found.push(table)
  }

  return found
}

/**
 * SQLite says `SCAN <table>` for a full read and `SEARCH <table> USING …` for
 * an indexed one, which is the whole distinction in two words.
 */
function fromSqlite(rows: Array<Record<string, unknown>>): Plan {
  const lines = rows.map((row) => String(row.detail ?? '')).filter((line) => line !== '')
  const scans: string[] = []

  for (const line of lines) {
    const match = /^SCAN (?:TABLE )?([^\s]+)/i.exec(line)

    if (match?.[1] !== undefined) scans.push(match[1])
  }

  return { scans, detail: lines.join('\n') }
}
