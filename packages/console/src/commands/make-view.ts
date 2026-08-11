import { Str } from '@elysian/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeViewCommand extends GeneratorCommand {
  static override signature =
    'make:view {name : View name, e.g. pages.about or pages/about} {--force : Overwrite an existing file}'

  static override description = 'Create a new Edge view'

  protected stub(): string {
    return 'view.stub'
  }

  protected type(): string {
    return 'View'
  }

  protected destination(name: string): string {
    return this.app.resourcePath('views', `${this.viewPath(name)}.edge`)
  }

  /**
   * Views address themselves with dots (`pages.about`), so the last dot segment
   * — not the last slash segment — is the view's own name.
   */
  protected override baseName(name: string): string {
    return Str.afterLast(this.viewPath(name), '/')
  }

  private viewPath(name: string): string {
    return Str.chopEnd(name.replace(/\\/g, '/'), '.edge').replace(/\./g, '/')
  }
}
