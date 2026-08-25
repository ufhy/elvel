import { PortInUseError } from '@elvel/core'
import pc from 'picocolors'
import { Command } from '../command.ts'

export class ServeCommand extends Command {
  static override signature = 'serve {--port= : Port to listen on} {--host= : Hostname to bind to}'

  static override description = 'Serve the application on the Bun development server'

  /**
   * The server outlives this command, and the entry point must not exit on it.
   *
   * This used to be `return new Promise(() => {})` — a promise nobody resolves,
   * awaited all the way up to `process.exit(await kernel.run())`. It kept the
   * process alive and it also broke `bun --hot`: Bun will not re-evaluate a
   * module graph whose entry is still evaluating, so every change to a view, a
   * controller or a route needed the server restarted, silently. Measured on
   * this application — five edits, five stale responses, nothing on the terminal
   * to say why.
   *
   * `Bun.serve` keeps the event loop alive by itself, so returning is enough.
   */
  static override holdsProcess = true

  async handle(): Promise<number> {
    const port = this.stringOption('port')
    const host = this.stringOption('host')

    /**
     * A port somebody else holds is not a crash, so it does not read like one.
     *
     * The developer who meets this is already confused — their last server looked
     * like it would not die — and a stack trace through the bootstrapper answers a
     * question they did not ask. The message names the port and the command that
     * finds the process.
     */
    try {
      await this.app.listen(port === '' ? undefined : Number(port), host === '' ? undefined : host)
    } catch (error) {
      if (!(error instanceof PortInUseError)) throw error

      this.error(error.message)

      return 1
    }

    const server = this.app.router.server
    const url = server ? `http://${server.hostname}:${server.port}` : this.app.url

    this.line()
    this.output.tag('INFO', `Server running on ${pc.underline(url)}`)
    this.comment(`  Environment: ${this.app.environment()}`)
    this.comment(`  Routes:      ${this.app.router.routes.length}`)
    this.line()
    this.comment('  Press Ctrl+C to stop.')
    this.line()

    /**
     * Returns, rather than waiting forever.
     *
     * The server is bound, and a bound server holds the event loop on its own —
     * so the process stays up without this command staying in it. What that buys
     * is the entry point finishing its evaluation, which is the one thing
     * `bun --hot` needs before it will reload anything.
     */
    return 0
  }
}
