import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { DatabaseServiceProvider } from '@elvel/database'
import { EventServiceProvider } from '@elvel/events'
import { LensServiceProvider } from '../src/provider.ts'

/**
 * What the provider wires, held to what the pieces do.
 *
 * Written after noticing that removing `listenForJobs(this.app)` from `boot()`
 * broke no test at all: the queue tests call the listener directly, so they
 * guarded its behaviour and not its registration. That is the same shape as the
 * `SESSION_ENCRYPT` gap found in the documentation audit — two halves that agree
 * only by inspection.
 */
async function boot(config: Record<string, unknown> = {}): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-provider')
  app.config.set('database.connections.lens-provider', { driver: 'sqlite', database: ':memory:' })
  app.config.set('lens.enabled', true)
  app.config.set('lens.watchers', { query: { enabled: true } })

  for (const [key, value] of Object.entries(config)) app.config.set(key, value)

  await new EventServiceProvider(app).register()
  await new DatabaseServiceProvider(app).register()

  const provider = new LensServiceProvider(app)

  await provider.register()
  await provider.boot()

  return app
}

describe('LensServiceProvider', () => {
  test('subscribes to the job events, so a worker opens and flushes a batch', async () => {
    const app = await boot()
    const events = app.make('events')

    expect(events.hasListeners('queue.job.processing')).toBe(true)
    expect(events.hasListeners('queue.job.processed')).toBe(true)
    expect(events.hasListeners('queue.job.failed')).toBe(true)
    expect(events.hasListeners('queue.job.released')).toBe(true)
  })

  test('registers the watchers the config asks for, and no others', async () => {
    const app = await boot({ 'lens.watchers': { query: { enabled: true }, request: false } })

    expect(app.make('events').hasListeners('db.query')).toBe(true)
    expect(app.make('events').hasListeners('log.message')).toBe(false)
  })

  test('binds the recorder and its storage', async () => {
    const app = await boot()

    expect(app.bound('lens')).toBe(true)
    expect(app.bound('lens.entries')).toBe(true)
  })

  /**
   * Disabled means nothing is attached, not that everything returns early.
   */
  test('attaches nothing at all when disabled', async () => {
    const app = await boot({ 'lens.enabled': false })

    expect(app.make('events').hasListeners('queue.job.processing')).toBe(false)
    expect(app.make('events').hasListeners('db.query')).toBe(false)
  })

  test('an unknown storage driver is refused at boot rather than at the first flush', async () => {
    await expect(boot({ 'lens.driver': 'elsewhere' })).rejects.toThrow('Unsupported storage driver')
  })
})
