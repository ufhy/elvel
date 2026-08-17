import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeRequestCommand extends GeneratorCommand {
  static override signature =
    'make:request {name : Request class name, e.g. StoreUser} {--force : Overwrite an existing file}'

  static override description = 'Create a new form request'

  protected stub(): string {
    return 'request.stub'
  }

  protected type(): string {
    return 'Request'
  }

  protected destination(name: string): string {
    return this.app.appPath('Http', 'Requests', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))

    return base.endsWith('Request') ? base : `${base}Request`
  }

  /** Stubs ship with this package, not with @elvel/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
