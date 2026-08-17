import { Str } from '@elyvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeProviderCommand extends GeneratorCommand {
  static override signature =
    'make:provider {name : Provider name, e.g. Route} {--force : Overwrite an existing file}'

  static override description = 'Create a new service provider'

  protected stub(): string {
    return 'provider.stub'
  }

  protected type(): string {
    return 'Provider'
  }

  protected destination(name: string): string {
    return this.app.appPath('Providers', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))
    return base.endsWith('ServiceProvider') ? base : `${base}ServiceProvider`
  }
}
