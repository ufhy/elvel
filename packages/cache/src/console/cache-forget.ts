import { Command } from '@elysian/console'

/** `cache:forget <key>` — drop one entry without flushing the store. */
export class CacheForgetCommand extends Command {
  static override signature =
    'cache:forget {key : The cache key to forget} {--store= : The store to forget it from}'

  static override description = 'Remove an item from the cache'

  async handle(): Promise<number> {
    const key = this.argument('key')
    if (key === '') {
      this.error('A key is required.')
      return 1
    }

    const store = this.stringOption('store')
    const repository = this.app.make('cache').store(store === '' ? undefined : store)

    const existed = await repository.forget(key)

    this.output.tag('INFO', existed ? `Forgotten: ${key}` : `Not cached: ${key}`)

    return 0
  }
}
