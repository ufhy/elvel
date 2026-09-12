import { Command } from '@elvel/console'
import { barState } from '../bar/enabled.ts'
import { tableIsMissing } from '../installed.ts'
import type { WatcherConfig } from '../watchers/index.ts'

/**
 * `lens:status` — is it on, and if not, why not.
 *
 * Written because there was no way to answer that without opening the dashboard
 * or the database, and the dashboard is the thing that will not open when
 * something is wrong. Every line here is a question somebody actually asks in
 * the first ten minutes: is it enabled, is it paused, are the tables there, is
 * anything being recorded, and which watchers are awake.
 */
export class LensStatusCommand extends Command {
  static override signature = 'lens:status'

  static override description = 'Report whether Lens is recording, and what it holds'

  async handle(): Promise<number> {
    const enabled = this.app.config.get<boolean>('lens.enabled', false)
    const lens = this.app.make('lens')
    const installed = await this.installed()

    this.line()
    this.output.pairs([
      ['Recording', this.recordingState(enabled, lens.isPaused(), installed)],
      ['Tables', installed === true ? 'ready' : installed === false ? 'MISSING' : 'unknown'],
      ['Driver', this.app.config.get<string>('lens.driver', 'database')],
      ['Dashboard', `/${this.app.config.get<string>('lens.path', 'lens')}`],
      ['Bar', barState(this.app).reason]
    ])

    if (installed === false) {
      this.line()
      this.error('The tables are not there. Run: elvel lens:table && elvel migrate')

      return 1
    }

    await this.reportEntries()
    this.reportWatchers()
    this.line()

    return 0
  }

  /** The four states, in the order a person would rule them out. */
  private recordingState(
    enabled: boolean,
    paused: boolean,
    installed: boolean | undefined
  ): string {
    if (!enabled) return 'OFF — set LENS_ENABLED=true'
    if (installed === false) return 'OFF — tables missing'
    if (paused) return 'PAUSED — run elvel lens:resume'

    return 'on'
  }

  /**
   * `undefined` when the question could not be asked at all.
   *
   * Probed with `count()` and not `monitoring()`, which was the first attempt
   * and is exactly the wrong tool: it catches a missing table on purpose so
   * recording survives one, so it answers "fine" when nothing is fine. The
   * command then walked on and died on the next query.
   */
  private async installed(): Promise<boolean | undefined> {
    try {
      await this.app.make('lens.entries').count()

      return true
    } catch (error) {
      return tableIsMissing(error) ? false : undefined
    }
  }

  private async reportEntries(): Promise<void> {
    const counts = await this.counts()

    this.line()

    if (counts.length === 0) {
      this.comment('Nothing recorded yet.')

      return
    }

    this.output.pairs([
      ...counts.map(([type, n]) => [type, n.toLocaleString('en-US')] as [string, string]),
      ['total', (await this.app.make('lens.entries').count()).toLocaleString('en-US')]
    ])
  }

  /**
   * Counted, not paged.
   *
   * The first version asked for a page and reported its length, which meant a
   * table of two hundred thousand requests read as `200` — the page size
   * wearing a number's clothes. Caught by running the command and disbelieving
   * the output.
   */
  private async counts(): Promise<Array<[string, number]>> {
    const { entryTypes } = await import('../entry-type.ts')
    const repository = this.app.make('lens.entries')
    const found: Array<[string, number]> = []

    for (const type of entryTypes()) {
      const total = await repository.count(type)

      if (total > 0) found.push([type, total])
    }

    return found
  }

  private reportWatchers(): void {
    const watchers = this.app.config.get<WatcherConfig>('lens.watchers', {})
    const off = Object.entries(watchers)
      .filter(([, options]) => options === false || options.enabled === false)
      .map(([name]) => name)

    this.line()

    if (off.length === 0) {
      this.comment('Every configured watcher is on.')

      return
    }

    this.comment(`Off: ${off.join(', ')}`)
  }
}
