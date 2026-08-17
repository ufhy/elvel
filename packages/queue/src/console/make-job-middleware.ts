import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'

export class MakeJobMiddlewareCommand extends GeneratorCommand {
  static override signature =
    'make:job-middleware {name : Middleware class name} {--force : Overwrite an existing file}'

  static override description = 'Create a new job middleware'

  protected stub(): string {
    return 'job-middleware.stub'
  }

  protected type(): string {
    return 'Job middleware'
  }

  protected destination(name: string): string {
    return this.app.appPath('Jobs/Middleware', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elyvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
