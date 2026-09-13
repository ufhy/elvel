import { join } from 'node:path'
import { Command } from '@elvel/console'

/**
 * `lens:install` — put the config in the application and say what is left.
 *
 * Lens publishes its own config rather than appearing in `config:publish`, and
 * and for one reason: `config:publish` is a catalogue of
 * capabilities an application configures and then calls, while a tool has to be
 * installed. Telescope is not in that catalogue either — it registers its
 * own publish group and `telescope:install` fetches the config, the migration
 * and the provider stub together, because any one of the three alone leaves the
 * tool inert.
 *
 * The same is true here. A published `config/lens.ts` with no tables records
 * nothing, and tables with `enabled: false` record nothing either. So this
 * writes the config and then prints the two steps it will not take on somebody's
 * behalf — generating a migration and editing `.env` are both changes they
 * should make deliberately.
 */
export class LensInstallCommand extends Command {
  static override signature =
    'lens:install {--force : Overwrite config/lens.ts if it already exists}'

  static override description = 'Publish the Lens configuration and print the remaining steps'

  async handle(): Promise<number> {
    const destination = this.app.configPath('lens.ts')

    if ((await Bun.file(destination).exists()) && this.option('force') !== true) {
      this.error('config/lens.ts already exists. Pass --force to overwrite it.')

      return 1
    }

    /**
     * Relative to this file, the way `MigrationGeneratorCommand` finds its stubs.
     *
     * `Bun.resolveSync('@elvel/lens/config/lens.ts', …)` was the first attempt
     * and it is the wrong tool: it resolves from the *application's* directory,
     * so it answers only when the application has installed us — which is the
     * common case but not the only one, and the failure is an exception rather
     * than a miss. The package always knows where its own default is, and `files`
     * ships `src` and `config` side by side, so the relative walk holds in a
     * tarball as much as in the repository.
     */
    const source = join(import.meta.dir, '..', '..', 'config', 'lens.ts')

    await Bun.write(destination, await Bun.file(source).text())

    this.info('Published config/lens.ts')

    await this.publishProvider()

    this.line('')
    this.line('Three steps left:')
    this.line("  1. Name the config in bootstrap/app.ts:  lens: () => import('../config/lens.ts')")
    this.line('  2. Register both providers, Lens after HttpServiceProvider:')
    this.line('       LensServiceProvider (yours), then LensServiceProvider from @elvel/lens')
    this.line('  3. Create the tables:                    elvel lens:table && elvel migrate')
    this.line('')
    this.comment('Then add yourself to authorise() and set LENS_ENABLED=true.')
    this.comment('Both are refusals until you do: the gate denies everyone and recording is off.')

    return 0
  }

  /**
   * Write the application's own provider, where the gate and the filter live.
   *
   * Never overwritten, `--force` or not: this is a file somebody edits, and the
   * one thing it holds is the list of people allowed to read the dashboard.
   * Losing that to a re-run of an install command would be a bad trade.
   */
  private async publishProvider(): Promise<void> {
    const destination = this.app.appPath('Providers', 'LensServiceProvider.ts')

    if (await Bun.file(destination).exists()) {
      this.comment('app/Providers/LensServiceProvider.ts already exists, left alone.')

      return
    }

    const source = join(import.meta.dir, '..', '..', 'stubs', 'lens-provider.stub')

    await Bun.write(destination, await Bun.file(source).text())

    this.info('Published app/Providers/LensServiceProvider.ts')
  }
}
