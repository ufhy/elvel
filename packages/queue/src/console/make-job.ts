import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeJobCommand extends GeneratorCommand {
  static override signature =
    'make:job {name : Job class name, e.g. SendWelcomeEmail} {--force : Overwrite an existing file}'

  static override description = 'Create a new queued job'

  protected stub(): string {
    return 'job.stub'
  }

  protected type(): string {
    return 'Job'
  }

  protected destination(name: string): string {
    return this.app.appPath('Jobs', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
