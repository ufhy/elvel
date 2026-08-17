import { Str } from '@elvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeMiddlewareCommand extends GeneratorCommand {
  static override signature =
    'make:middleware {name : Middleware name, e.g. EnsureSubscribed} {--force : Overwrite an existing file}'

  static override description = 'Create a new route middleware'

  protected stub(): string {
    return 'middleware.stub'
  }

  protected type(): string {
    return 'Middleware'
  }

  protected destination(name: string): string {
    return this.app.appPath('Http', 'Middleware', `${this.className(name)}.ts`)
  }

  /**
   * The alias suggested in the file, derived from the name.
   *
   * `EnsureSubscribed` becomes `subscribed` rather than `ensure-subscribed`:
   * Laravel's own aliases read as the condition (`auth`, `verified`, `signed`),
   * and the `Ensure` prefix is a class-naming habit, not part of what it checks.
   */
  protected override replacements(name: string): Record<string, string> {
    const base = Str.studly(this.baseName(name))
    const condition = base.replace(/^(Ensure|Require|Redirect(If)?)/, '') || base

    return {
      ...super.replacements(name),
      alias: Str.kebab(condition),
      camel: Str.camel(base)
    }
  }
}
