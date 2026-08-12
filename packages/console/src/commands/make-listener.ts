import { Str } from '@elysian/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeListenerCommand extends GeneratorCommand {
  static override signature =
    'make:listener {name : Listener class name, e.g. SendWelcomeEmail} {--event= : Event name to subscribe to} {--queued : Run the listener in a worker instead of the request} {--force : Overwrite an existing file}'

  static override description = 'Create a new event listener'

  protected stub(): string {
    // A queued listener is a different shape entirely — a class the worker
    // resolves by name, not a subscriber registering a closure.
    return this.flag('queued') ? 'listener.queued.stub' : 'listener.stub'
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
      dotted: event === '' ? 'event.name' : Str.snake(Str.afterLast(event, '/'), '.'),
      // A queued listener is typed against the event class, so it needs the name
      // as written rather than the dotted form.
      event: event === '' ? 'Event' : Str.studly(Str.afterLast(event, '/'))
    }
  }
}
