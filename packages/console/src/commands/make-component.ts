import { Str } from '@elvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeComponentCommand extends GeneratorCommand {
  static override signature =
    'make:component {name : Component name, e.g. Alert or forms/Input} {--force : Overwrite an existing file}'

  static override description = 'Create a new view component'

  protected stub(): string {
    return 'component.stub'
  }

  protected type(): string {
    return 'Component'
  }

  protected destination(name: string): string {
    const normalized = name.replace(/\\/g, '/').replace(/\./g, '/')
    const directory = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : ''

    return this.app.resourcePath(
      'views',
      'components',
      ...(directory === '' ? [] : [directory]),
      `${this.className(name)}.tsx`
    )
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  protected override baseName(name: string): string {
    return Str.afterLast(name.replace(/\\/g, '/').replace(/\./g, '/'), '/')
  }
}
