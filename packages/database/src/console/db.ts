import { Command } from '@elysian/console'

/**
 * Hand the connection over to the database's own client — Laravel's `db`.
 *
 * The point is not to write another REPL: `psql`, `mysql` and `sqlite3` already
 * exist and are better than anything this could be. What this saves is reading
 * the config, assembling the flags and getting the password in without putting
 * it in shell history.
 */
export class DbCommand extends Command {
  static override signature =
    'db {connection? : The connection to open, or the default} {--print : Print the command instead of running it}'

  static override description = 'Open a database CLI session'

  async handle(): Promise<number> {
    // The config is read rather than a connection opened: this hands over to an
    // external client, and opening a connection here would only prove the
    // database is reachable from a process that is about to exit.
    const requested = this.argument('connection')
    const name = requested === '' ? undefined : requested

    const config = this.configFor(name)
    if (config === undefined) return 1

    const [program, ...args] = config.command

    if (this.flag('print')) {
      // The password is replaced rather than printed: this exists to be pasted,
      // and a printed password ends up in a scrollback buffer.
      this.line(
        [program, ...args].map((part) => (part === config.password ? '********' : part)).join(' ')
      )

      return 0
    }

    const spawned = Bun.spawn([program as string, ...args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, ...config.env }
    })

    return await spawned.exited
  }

  private configFor(
    name: string | undefined
  ): { command: string[]; env: Record<string, string>; password?: string } | undefined {
    const connections = this.app.config.get<Record<string, Record<string, unknown>>>(
      'database.connections',
      {}
    )
    const key = name ?? this.app.config.get<string>('database.default', '')
    const config = connections[key]

    if (config === undefined) {
      this.error(`No connection named [${key}] in config/database.ts.`)
      this.comment(`Configured: ${Object.keys(connections).join(', ') || '(none)'}`)

      return undefined
    }

    const value = (field: string) => String(config[field] ?? '')
    const driver = value('driver')

    if (driver === 'sqlite') {
      return { command: ['sqlite3', value('database')], env: {} }
    }

    if (driver === 'postgres') {
      return {
        command: [
          'psql',
          '--host',
          value('host'),
          '--port',
          value('port') || '5432',
          '--username',
          value('username'),
          value('database')
        ],
        // Postgres reads the password from the environment; passing it as a flag
        // would put it in the process list for every user on the machine.
        env: { PGPASSWORD: value('password') },
        password: value('password')
      }
    }

    if (driver === 'mysql') {
      return {
        command: [
          'mysql',
          '--host',
          value('host'),
          '--port',
          value('port') || '3306',
          '--user',
          value('username'),
          `--password=${value('password')}`,
          value('database')
        ],
        env: {},
        password: value('password')
      }
    }

    this.error(`No client is known for the [${driver}] driver.`)

    return undefined
  }
}
