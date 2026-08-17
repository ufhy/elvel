import { Str } from '@elvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeCommandCommand extends GeneratorCommand {
  static override signature =
    'make:command {name : Command class name, e.g. SendReports} {--force : Overwrite an existing file}'

  static override description = 'Create a new Artisan command'

  protected stub(): string {
    return 'command.stub'
  }

  protected type(): string {
    return 'Command'
  }

  protected destination(name: string): string {
    return this.app.appPath('Console', 'Commands', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  protected override replacements(name: string): Record<string, string> {
    const base = Str.studly(this.baseName(name))

    return {
      ...super.replacements(name),
      // `SendReports` -> default signature `send:reports`
      kebab: Str.snake(base, ':')
    }
  }
}
