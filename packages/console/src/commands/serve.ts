import { PortInUseError } from '@elvel/core'
import pc from 'picocolors'
import { Command } from '../command.ts'

export class ServeCommand extends Command {
  static override signature = 'serve {--port= : Port to listen on} {--host= : Hostname to bind to}'

  static override description = 'Serve the application on the Bun development server'

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

    // Hand control to the event loop; the process stays alive on the server.
    return new Promise<number>(() => {})
  }
}
