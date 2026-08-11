import { mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Str } from '@elysian/support'
import { Command } from './command.ts'

/**
 * Base class for `make:*` commands.
 *
 * Stubs are resolved from the application first (`stubs/<name>` in the project
 * root) and fall back to the ones shipped with this package — the same override
 * mechanism as Artisan's `stub:publish`.
 */
export abstract class GeneratorCommand extends Command {
  /** Stub file name, e.g. `controller.stub`. */
  protected abstract stub(): string

  /** Human label used in output: "Controller", "View". */
  protected abstract type(): string

  /** Absolute destination path for the generated file. */
  protected abstract destination(name: string): string

  /** Placeholder values substituted into the stub. */
  protected replacements(name: string): Record<string, string> {
    // Casing derives from the base name: `pages.about` is the view "about"
    // inside `pages`, not a thing called "PagesAbout".
    const base = this.baseName(name)

    return {
      class: this.className(name),
      name,
      studly: Str.studly(base),
      camel: Str.camel(base),
      kebab: Str.kebab(base),
      snake: Str.snake(base),
      plural: Str.kebab(Str.plural(base)),
      singular: Str.kebab(Str.singular(base))
    }
  }

  async handle(): Promise<number> {
    const name = this.argument('name')
    if (name === '') {
      this.error('A name is required.')
      return 1
    }

    const destination = this.destination(name)
    const file = Bun.file(destination)

    if ((await file.exists()) && !this.flag('force')) {
      this.error(`${this.type()} already exists: ${this.relative(destination)}`)
      this.comment('Pass --force to overwrite it.')
      return 1
    }

    const stub = await this.readStub()
    const contents = Str.replacePlaceholders(stub, this.replacements(name))

    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, contents)

    this.output.tag('INFO', `${this.type()} created: ${this.relative(destination)}`)
    return 0
  }

  protected className(name: string): string {
    return Str.studly(this.baseName(name))
  }

  /** `admin/posts` -> `posts`, so nested names keep their class name clean. */
  protected baseName(name: string): string {
    return Str.afterLast(name.replace(/\\/g, '/'), '/')
  }

  /** `admin/posts` -> `admin`, the subdirectory part of a nested name. */
  protected subDirectory(name: string): string {
    const normalized = name.replace(/\\/g, '/')
    return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
  }

  protected relative(path: string): string {
    return relative(this.app.basePath(), path)
  }

  private async readStub(): Promise<string> {
    const published = Bun.file(this.app.basePath('stubs', this.stub()))
    if (await published.exists()) return published.text()

    const shipped = Bun.file(join(import.meta.dir, '..', 'stubs', this.stub()))
    if (await shipped.exists()) return shipped.text()

    throw new Error(`Stub "${this.stub()}" not found.`)
  }
}
