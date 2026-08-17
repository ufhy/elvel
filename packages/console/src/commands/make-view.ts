import { Str } from '@elyvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeViewCommand extends GeneratorCommand {
  static override signature =
    'make:view {name : View name, e.g. pages.about or pages/about} {--force : Overwrite an existing file}'

  static override description = 'Create a new view component'

  protected stub(): string {
    return 'view.stub'
  }

  protected type(): string {
    return 'View'
  }

  protected destination(name: string): string {
    return this.app.resourcePath('views', `${this.viewPath(name)}.tsx`)
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  /**
   * Views address themselves with dots (`pages.about`), so the last dot segment
   * — not the last slash segment — is the view's own name.
   */
  protected override baseName(name: string): string {
    return Str.afterLast(this.viewPath(name), '/')
  }

  protected override replacements(name: string): Record<string, string> {
    return {
      ...super.replacements(name),
      // The layout lives at `resources/views/components/layout.tsx`, so a page
      // nested two levels deep needs two `../` hops.
      layoutImport: this.layoutImport(name)
    }
  }

  private layoutImport(name: string): string {
    const depth = this.viewPath(name).split('/').length - 1
    const hops = depth === 0 ? './' : '../'.repeat(depth)

    return `${hops}components/layout.tsx`
  }

  private viewPath(name: string): string {
    return Str.chopEnd(name.replace(/\\/g, '/'), '.tsx').replace(/\./g, '/')
  }
}
