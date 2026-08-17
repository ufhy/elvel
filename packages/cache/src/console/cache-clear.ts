import { Command } from '@elvel/console'

/**
 * `cache:clear`
 *
 * Flushes a store. Note what a *tagged* flush cannot do: it only rotates the tag
 * ids, so entries written under a tag stay on disk until their TTL runs out. Pass
 * `--tags` to rotate those rather than clearing the whole store.
 */
export class CacheClearCommand extends Command {
  static override signature =
    'cache:clear {--store= : The store to flush} {--tags= : Comma-separated tags to flush instead}'

  static override description = 'Flush the application cache'

  async handle(): Promise<number> {
    const store = this.stringOption('store')
    const repository = this.app.make('cache').store(store === '' ? undefined : store)

    const tags = this.stringOption('tags')

    if (tags !== '') {
      const names = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)

      await repository.tags(names).flush()
      this.output.tag('INFO', `Flushed tag(s): ${names.join(', ')}`)

      return 0
    }

    await repository.flush()
    this.output.tag('INFO', `Cache store [${store === '' ? 'default' : store}] flushed.`)

    return 0
  }
}
