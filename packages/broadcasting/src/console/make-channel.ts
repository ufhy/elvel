import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'

export class MakeChannelCommand extends GeneratorCommand {
  static override signature =
    'make:channel {name : Channel name, e.g. Orders} {--force : Overwrite an existing file}'

  static override description = 'Create a new broadcast channel authorizer'

  protected stub(): string {
    return 'channel.stub'
  }

  protected type(): string {
    return 'Channel'
  }

  protected destination(name: string): string {
    return this.app.appPath('Broadcasting', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
