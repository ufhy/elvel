import { GeneratorCommand } from '../generator.ts'

export class MakeExceptionCommand extends GeneratorCommand {
  static override signature =
    'make:exception {name : Exception class name} {--force : Overwrite an existing file}'

  static override description = 'Create a new exception class'

  protected stub(): string {
    return 'exception.stub'
  }

  protected type(): string {
    return 'Exception'
  }

  protected destination(name: string): string {
    return this.app.appPath('Exceptions', `${this.className(name)}.ts`)
  }
}
