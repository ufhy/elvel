import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeMailCommand extends GeneratorCommand {
  static override signature =
    'make:mail {name : Mailable class name, e.g. ArticlePublished} {--force : Overwrite an existing file}'

  static override description = 'Create a new mailable'

  protected stub(): string {
    return 'mail.stub'
  }

  protected type(): string {
    return 'Mailable'
  }

  protected destination(name: string): string {
    return this.app.appPath('Mail', `${this.className(name)}.ts`)
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
