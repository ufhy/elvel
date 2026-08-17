import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'
import { Str } from '@elyvel/support'

export class MakePolicyCommand extends GeneratorCommand {
  static override signature =
    'make:policy {name : Policy class name, e.g. Article} {--force : Overwrite an existing file}'

  static override description = 'Create a new policy'

  protected stub(): string {
    return 'policy.stub'
  }

  protected type(): string {
    return 'Policy'
  }

  protected destination(name: string): string {
    return this.app.appPath('Policies', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))

    return base.endsWith('Policy') ? base : `${base}Policy`
  }

  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
