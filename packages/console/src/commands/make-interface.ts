import { GeneratorCommand } from '../generator.ts'

export class MakeInterfaceCommand extends GeneratorCommand {
  static override signature =
    'make:interface {name : Interface name} {--force : Overwrite an existing file}'

  static override description = 'Create a new interface'

  protected stub(): string {
    return 'interface.stub'
  }

  protected type(): string {
    return 'Interface'
  }

  protected destination(name: string): string {
    return this.app.appPath('Contracts', `${this.className(name)}.ts`)
  }
}
