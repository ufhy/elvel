import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'

export class MakeObserverCommand extends GeneratorCommand {
  static override signature =
    'make:observer {name : Observer class name, e.g. ArticleObserver} {--force : Overwrite an existing file}'

  static override description = 'Create a new model observer'

  protected stub(): string {
    return 'observer.stub'
  }

  protected type(): string {
    return 'Observer'
  }

  protected destination(name: string): string {
    return this.app.appPath('Observers', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elyvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
