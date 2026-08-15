import { Str } from '@elysian/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeConfigCommand extends GeneratorCommand {
  static override signature =
    'make:config {name : Config file name, e.g. billing} {--force : Overwrite an existing file}'

  static override description = 'Create a new configuration file'

  protected stub(): string {
    return 'config.stub'
  }

  protected type(): string {
    return 'Config'
  }

  protected destination(name: string): string {
    return this.app.basePath('config', `${Str.kebab(this.baseName(name))}.ts`)
  }
}
