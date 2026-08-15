import { GeneratorCommand } from '../generator.ts'

export class MakeClassCommand extends GeneratorCommand {
  static override signature =
    'make:class {name : Class name, may be nested as Support/Money} {--force : Overwrite an existing file}'

  static override description = 'Create a new class'

  protected stub(): string {
    return 'class.stub'
  }

  protected type(): string {
    return 'Class'
  }

  protected destination(name: string): string {
    return this.app.appPath(this.subDirectory(name), `${this.className(name)}.ts`)
  }
}
