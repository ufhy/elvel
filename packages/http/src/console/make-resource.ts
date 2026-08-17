import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeResourceCommand extends GeneratorCommand {
  static override signature =
    'make:resource {name : Resource class name, e.g. User} {--force : Overwrite an existing file}'

  static override description = 'Create a new JSON resource'

  protected stub(): string {
    return 'resource.stub'
  }

  protected type(): string {
    return 'Resource'
  }

  protected destination(name: string): string {
    return this.app.appPath('Http', 'Resources', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))

    return base.endsWith('Resource') ? base : `${base}Resource`
  }

  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
