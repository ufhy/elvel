import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'

export class MakeCastCommand extends GeneratorCommand {
  static override signature =
    'make:cast {name : Cast class name, e.g. Money} {--force : Overwrite an existing file}'

  static override description = 'Create a new attribute cast'

  protected stub(): string {
    return 'cast.stub'
  }

  protected type(): string {
    return 'Cast'
  }

  protected destination(name: string): string {
    return this.app.appPath('Casts', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elyvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
