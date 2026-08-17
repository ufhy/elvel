import { Str } from '@elyvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeEventCommand extends GeneratorCommand {
  static override signature =
    'make:event {name : Event class name, e.g. UserRegistered} {--force : Overwrite an existing file}'

  static override description = 'Create a new event class'

  protected stub(): string {
    return 'event.stub'
  }

  protected type(): string {
    return 'Event'
  }

  protected destination(name: string): string {
    return this.app.appPath('Events', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  protected override replacements(name: string): Record<string, string> {
    return {
      ...super.replacements(name),
      // `UserRegistered` -> `user.registered`, the stable wildcard-friendly name
      dotted: Str.snake(this.baseName(name), '.')
    }
  }
}
