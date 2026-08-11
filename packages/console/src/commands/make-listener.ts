import { Str } from '@elysian/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeListenerCommand extends GeneratorCommand {
  static override signature =
    'make:listener {name : Listener class name, e.g. SendWelcomeEmail} {--event= : Event name to subscribe to} {--force : Overwrite an existing file}'

  static override description = 'Create a new event listener'

  protected stub(): string {
    return 'listener.stub'
  }

  protected type(): string {
    return 'Listener'
  }

  protected destination(name: string): string {
    return this.app.appPath('Listeners', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  protected override replacements(name: string): Record<string, string> {
    const event = this.stringOption('event')

    return {
      ...super.replacements(name),
      dotted: event === '' ? 'event.name' : Str.snake(Str.afterLast(event, '/'), '.')
    }
  }
}
