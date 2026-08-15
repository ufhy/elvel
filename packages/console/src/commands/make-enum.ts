import { GeneratorCommand } from '../generator.ts'

export class MakeEnumCommand extends GeneratorCommand {
  static override signature =
    'make:enum {name : Enum name, e.g. ArticleStatus} {--force : Overwrite an existing file}'

  static override description = 'Create a new enum'

  protected stub(): string {
    return 'enum.stub'
  }

  protected type(): string {
    return 'Enum'
  }

  protected destination(name: string): string {
    return this.app.appPath('Enums', `${this.className(name)}.ts`)
  }
}
