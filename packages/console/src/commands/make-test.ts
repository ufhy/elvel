import { Str } from '@elyvel/support'
import { GeneratorCommand } from '../generator.ts'

/**
 * Tests land in `test/`, mirroring the name given.
 *
 * There is no unit/feature split the way Laravel has one: `bun test` takes a
 * path, so the directories a project wants are the directories it makes. What
 * matters is that the file ends in `.test.ts`, which is what the runner looks
 * for — a generator that produced `ArticleTest.ts` would write a file nothing
 * ever runs.
 */
export class MakeTestCommand extends GeneratorCommand {
  static override signature =
    'make:test {name : Test name, may be nested as http/articles} {--force : Overwrite an existing file}'

  static override description = 'Create a new test file'

  protected stub(): string {
    return 'test.stub'
  }

  protected type(): string {
    return 'Test'
  }

  protected destination(name: string): string {
    const directory = this.subDirectory(name)
    const file = `${Str.kebab(this.baseName(name))}.test.ts`

    return this.app.basePath('test', directory, file)
  }
}
