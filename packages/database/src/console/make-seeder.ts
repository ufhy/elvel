import { join } from 'node:path'
import { GeneratorCommand } from '@elvel/console'
import { Str } from '@elvel/support'

export class MakeSeederCommand extends GeneratorCommand {
  static override signature =
    'make:seeder {name : Seeder class name, e.g. UserSeeder} {--force : Overwrite an existing file}'

  static override description = 'Create a new seeder'

  protected stub(): string {
    return 'seeder.stub'
  }

  protected type(): string {
    return 'Seeder'
  }

  protected destination(name: string): string {
    return this.app.basePath('database', 'seeders', `${this.className(name)}.ts`)
  }

  protected override className(name: string): string {
    const base = Str.studly(this.baseName(name))

    return base.endsWith('Seeder') ? base : `${base}Seeder`
  }

  protected override async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    return Bun.file(join(import.meta.dir, '..', '..', 'stubs', this.stub())).text()
  }
}
