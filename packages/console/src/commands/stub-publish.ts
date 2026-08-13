import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Command } from '../command.ts'

/**
 * `stub:publish` — copy the framework's stubs into the project so they can be edited.
 *
 * Every generator already prefers `stubs/<name>` in the project root over the one
 * it ships with, so this command only puts the files where they can be found.
 * That is worth a command rather than a documentation line because the stubs are
 * spread across a dozen packages inside `node_modules`, and finding the one you
 * want by hand is the reason people give up and edit generated files instead.
 *
 * Existing files are left alone unless `--force` is given: the whole point of
 * publishing is to change them, and overwriting an edit is the one outcome that
 * loses work.
 */
export class StubPublishCommand extends Command {
  static override signature =
    'stub:publish {--force : Overwrite stubs that are already published} {--list : Show what would be published, and from where}'

  static override description = "Publish the framework's stubs for editing"

  async handle(): Promise<number> {
    const stubs = await this.discover()

    if (stubs.length === 0) {
      this.error('No stubs found. Are the framework packages installed?')

      return 1
    }

    const target = this.app.basePath('stubs')

    if (this.flag('list')) {
      this.output.table(
        ['Stub', 'From'],
        stubs.map((stub) => [stub.name, this.relative(stub.path)])
      )

      return 0
    }

    await mkdir(target, { recursive: true })

    let published = 0
    let skipped = 0

    for (const stub of stubs) {
      const destination = join(target, stub.name)

      if ((await Bun.file(destination).exists()) && !this.flag('force')) {
        skipped += 1

        continue
      }

      await Bun.write(destination, await Bun.file(stub.path).text())
      published += 1
    }

    this.output.tag('INFO', `Published ${published} stub(s) to ${this.relative(target)}.`)

    if (skipped > 0) {
      this.comment(`${skipped} already published and left alone. Pass --force to replace them.`)
    }

    return 0
  }

  /**
   * Every `stubs/` directory the installed packages carry.
   *
   * Walked from this package's own location rather than from a list: the stubs
   * live beside each package that owns them, so a package added later brings its
   * stubs with it and a list here would go stale silently.
   *
   * A name that appears twice keeps the first — packages do not share stub names
   * today, and if two ever did, publishing whichever came last alphabetically
   * would be worse than picking one and saying so.
   */
  private async discover(): Promise<Array<{ name: string; path: string }>> {
    const packages = join(import.meta.dir, '..', '..', '..')
    const found = new Map<string, string>()

    for (const entry of await readdir(packages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const directory = join(packages, entry.name, 'stubs')

      try {
        for (const file of await readdir(directory)) {
          if (!file.endsWith('.stub')) continue
          if (!found.has(file)) found.set(file, join(directory, file))
        }
      } catch {
        // A package without stubs is the common case, not an error.
      }
    }

    return [...found.entries()]
      .map(([name, path]) => ({ name, path }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private relative(path: string): string {
    const from = relative(this.app.basePath(), path)

    return from.startsWith('..') ? dirname(path) : from
  }
}
