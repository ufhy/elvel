import { join } from 'node:path'
import { Command } from '../command.ts'

/** Shared by the installers: read a stub, and edit the bootstrap carefully. */
abstract class InstallCommand extends Command {
  /** Application stubs win, as they do for every generator. */
  protected async readStub(name: string): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', name))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', name)).text()
  }

  /**
   * Add a line to `bootstrap/app.ts`, or say what to add.
   *
   * Editing somebody's bootstrap by pattern-matching is the kind of help that
   * silently does the wrong thing to a file that was customised. When the shape
   * is not the one shipped, this prints the line instead — slower, and always
   * correct.
   */
  protected async wire(line: string, what: string): Promise<number> {
    const path = this.app.basePath('bootstrap', 'app.ts')
    const file = Bun.file(path)

    if (!(await file.exists())) {
      this.warn(`No bootstrap/app.ts. Load ${what} yourself.`)

      return 0
    }

    const source = await file.text()

    if (source.includes(what)) {
      this.comment(`  bootstrap/app.ts already loads ${what}.`)

      return 0
    }

    const anchor = source.match(/^\s*\.withRoutes\(.*\)$/m)

    if (!anchor?.[0]) {
      this.warn('Could not find a .withRoutes() call in bootstrap/app.ts.')
      this.comment(`  Add this line yourself:\n${line}`)

      return 0
    }

    await Bun.write(path, source.replace(anchor[0], `${anchor[0]}\n${line}`))
    this.output.tag('INFO', `Wired ${what} into bootstrap/app.ts.`)

    return 0
  }
}

/**
 * `install:api` — add the JSON half of the application.
 *
 * A scaffold ships `routes/web.ts` only, because most applications start as
 * pages. Adding an API afterwards means a routes file, a prefix and a line in
 * the bootstrap, and the line in the bootstrap is the one people forget — the
 * file exists, the routes are written, and nothing answers.
 */
export class InstallApiCommand extends InstallCommand {
  static override signature = 'install:api {--force : Overwrite an existing routes/api.ts}'

  static override description = 'Add an API routes file and wire it into the bootstrap'

  async handle(): Promise<number> {
    const routes = this.app.basePath('routes', 'api.ts')

    if ((await Bun.file(routes).exists()) && !this.flag('force')) {
      this.error('routes/api.ts already exists. Pass --force to overwrite it.')

      return 1
    }

    await Bun.write(routes, await this.readStub('routes-api.stub'))
    this.output.tag('INFO', 'Created routes/api.ts.')

    return await this.wire("  .withRoutes(() => import('../routes/api.ts'))", 'routes/api.ts')
  }
}

/**
 * `install:broadcasting` — the config file the provider reads.
 *
 * The provider is registered by the scaffold, so broadcasting already works on
 * its defaults; this writes the file that makes those defaults visible and
 * changeable, plus a channel to copy.
 */
export class InstallBroadcastingCommand extends InstallCommand {
  static override signature =
    'install:broadcasting {--force : Overwrite an existing config/broadcasting.ts}'

  static override description = 'Add the broadcasting config file'

  async handle(): Promise<number> {
    const config = this.app.configPath('broadcasting.ts')

    if ((await Bun.file(config).exists()) && !this.flag('force')) {
      this.error('config/broadcasting.ts already exists. Pass --force to overwrite it.')

      return 1
    }

    await Bun.write(config, await this.readStub('config-broadcasting.stub'))

    this.output.tag('INFO', 'Created config/broadcasting.ts.')
    this.comment('  Declare channels with: elvel make:channel <Name>')

    return 0
  }
}
