import { Str } from '@elyvel/support'
import { GeneratorCommand } from '../generator.ts'

export class MakeControllerCommand extends GeneratorCommand {
  static override signature =
    'make:controller {name : Controller name, e.g. Post or admin/Post} {--r|resource : Generate index/show/store/update/destroy routes} {--force : Overwrite an existing file}'

  static override description = 'Create a new controller'

  protected stub(): string {
    return this.flag('resource') ? 'controller.resource.stub' : 'controller.stub'
  }

  protected type(): string {
    return 'Controller'
  }

  protected destination(name: string): string {
    const directory = this.subDirectory(name)
    const file = `${this.className(name)}.ts`

    return this.app.appPath('Http', 'Controllers', ...(directory === '' ? [] : [directory]), file)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))
    return base.endsWith('Controller') ? base : `${base}Controller`
  }

  protected override replacements(name: string): Record<string, string> {
    const base = Str.chopEnd(Str.studly(this.baseName(name)), 'Controller')

    return {
      ...super.replacements(name),
      class: this.className(name),
      studly: base,
      kebab: Str.kebab(base),
      plural: Str.kebab(Str.plural(base)),
      singular: Str.kebab(Str.singular(base))
    }
  }
}
