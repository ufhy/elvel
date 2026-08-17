import { join } from 'node:path'
import { GeneratorCommand } from '@elyvel/console'
import { Str } from '@elyvel/support'

export class MakeNotificationCommand extends GeneratorCommand {
  static override signature =
    'make:notification {name : Notification class name, e.g. ArticlePublished} {--force : Overwrite an existing file}'

  static override description = 'Create a new notification'

  protected stub(): string {
    return 'notification.stub'
  }

  protected type(): string {
    return 'Notification'
  }

  protected destination(name: string): string {
    return this.app.appPath('Notifications', `${this.className(name)}.ts`)
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
