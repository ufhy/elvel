import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeFactoryCommand extends GeneratorCommand {
  static override signature =
    'make:factory {name : Factory class name, e.g. UserFactory} {--model= : The model it builds} {--force : Overwrite an existing file}'

  static override description = 'Create a new model factory'

  protected stub(): string {
    return 'factory.stub'
  }

  protected type(): string {
    return 'Factory'
  }

  protected destination(name: string): string {
    return this.app.basePath('database', 'factories', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))

    return base.endsWith('Factory') ? base : `${base}Factory`
  }

  protected override replacements(name: string): Record<string, string> {
    const explicit = this.stringOption('model')
    const inferred = Str.chopEnd(Str.studly(this.baseName(name)), 'Factory')

    return { ...super.replacements(name), model: explicit === '' ? inferred : Str.studly(explicit) }
  }

  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
