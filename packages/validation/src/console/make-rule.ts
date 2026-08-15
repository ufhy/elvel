import { join } from 'node:path'
import { GeneratorCommand } from '@elysian/console'

export class MakeRuleCommand extends GeneratorCommand {
  static override signature =
    'make:rule {name : Rule name, e.g. Uppercase} {--force : Overwrite an existing file}'

  static override description = 'Create a new validation rule'

  protected stub(): string {
    return 'rule.stub'
  }

  protected type(): string {
    return 'Rule'
  }

  protected destination(name: string): string {
    return this.app.appPath('Rules', `${this.className(name)}.ts`)
  }

  /** Stubs ship with this package, not with @elysian/console. */
  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
