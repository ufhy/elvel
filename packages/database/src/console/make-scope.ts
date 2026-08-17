import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'

export class MakeScopeCommand extends GeneratorCommand {
  static override signature =
    'make:scope {name : Scope name, e.g. Published} {--force : Overwrite an existing file}'

  static override description = 'Create a new global query scope'

  protected stub(): string {
    return 'scope.stub'
  }

  protected type(): string {
    return 'Scope'
  }

  protected destination(name: string): string {
    return this.app.appPath('Models/Scopes', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elyvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
