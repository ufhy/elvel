import pc from 'picocolors'
import { Command } from '../command.ts'

export class AboutCommand extends Command {
  static override signature = 'about'

  static override description = 'Display basic information about the application'

  handle(): number {
    this.line()
    this.line(pc.bold('  Environment'))
    this.output.pairs([
      ['Application Name', this.app.config.get('app.name', 'Elvel')],
      ['Environment', this.app.environment()],
      ['Debug Mode', this.app.hasDebugModeEnabled() ? 'ENABLED' : 'OFF'],
      ['URL', this.app.url],
      ['Bun', Bun.version],
      ['Elysia', this.elysiaVersion()]
    ])

    this.line()
    this.line(pc.bold('  Paths'))
    this.output.pairs([
      ['Base', this.app.basePath()],
      ['Config', this.app.configPath()],
      ['Views', this.app.resourcePath('views')],
      ['Public', this.app.publicPath()]
    ])

    this.line()
    this.line(pc.bold('  Runtime'))
    this.output.pairs([
      ['Registered Routes', String(this.app.router.routes.length)],
      ['View Engine', this.app.bound('view') ? 'JSX (@kitajs/html)' : 'not installed']
    ])
    this.line()

    return 0
  }

  private elysiaVersion(): string {
    try {
      const pkg = require('elysia/package.json') as { version?: string }
      return pkg.version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
