import type { ConnectionManager } from '../connection/manager.ts'
import { MigrationCommand } from './base.ts'

/**
 * How many connections are open, against a threshold — Laravel's `db:monitor`.
 *
 * Built for a scheduled run: it exits non-zero when a connection is over its
 * limit, so a cron wrapper or a healthcheck can act on it without parsing the
 * output. SQLite has no such notion and says so rather than reporting a zero
 * that would look like good news.
 */
export class DbMonitorCommand extends MigrationCommand {
  static override signature =
    'db:monitor {--databases= : Comma-separated connections to check, or all of them} {--max=100 : Connections above which this is a failure} {--json : Output as JSON}'

  static override description = 'Report how many connections each database has open'

  async handle(): Promise<number> {
    const manager = this.app.make('db') as ConnectionManager
    const configured = Object.keys(
      this.app.config.get<Record<string, unknown>>('database.connections', {})
    )

    const requested = this.stringOption('databases')
    const names =
      requested === ''
        ? [this.app.config.get<string>('database.default', '')]
        : requested
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)

    const max = Number(this.stringOption('max', '100'))
    const results: Array<{ connection: string; connections: number | null; note: string }> = []

    for (const name of names) {
      if (!configured.includes(name)) {
        results.push({ connection: name, connections: null, note: 'not configured' })
        continue
      }

      results.push(await this.count(manager, name))
    }

    if (this.flag('json')) {
      this.line(JSON.stringify({ max, results }, null, 2))
    } else {
      this.line()
      this.table(
        ['CONNECTION', 'OPEN', 'NOTE'],
        results.map((one) => [
          one.connection,
          one.connections === null ? '—' : String(one.connections),
          one.note
        ])
      )
      this.line()
    }

    const over = results.filter((one) => one.connections !== null && one.connections > max)

    for (const one of over) {
      this.error(`[${one.connection}] has ${one.connections} connections open, above ${max}.`)
    }

    // Non-zero so a scheduler or a healthcheck can act without reading the text.
    return over.length > 0 ? 1 : 0
  }

  private async count(
    manager: ConnectionManager,
    name: string
  ): Promise<{ connection: string; connections: number | null; note: string }> {
    try {
      const connection = await manager.connection(name)
      const dialect = connection.grammar.dialect

      if (dialect === 'sqlite') {
        // A file, not a server: there is nothing to be over the limit.
        return { connection: name, connections: null, note: 'sqlite has no connection limit' }
      }

      const sql =
        dialect === 'postgres'
          ? 'select count(*)::int as total from pg_stat_activity where datname = current_database()'
          : 'select count(*) as total from information_schema.processlist where db = database()'

      const [row] = await connection.select<{ total: number }>(sql)

      return { connection: name, connections: Number(row?.total ?? 0), note: dialect }
    } catch (error) {
      return {
        connection: name,
        connections: null,
        note: error instanceof Error ? error.message.slice(0, 60) : 'unreachable'
      }
    }
  }
}
