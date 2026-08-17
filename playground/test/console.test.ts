import { afterEach, describe, expect, test as it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Output } from '@elvel/console'
import { artisan } from '@elvel/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * Artisan commands, run in the application rather than shelled out to.
 *
 * `artisan()` drives the same kernel `bun artisan.ts` does, so a command that
 * needs a booted container gets one — and the exit code, the output and any
 * prompt are all assertable. Spawning a process instead would test that Bun can
 * start, and would hide the exit code behind a shell.
 */
const kernel = app.make('artisan')
const written: string[] = []

afterEach(async () => {
  // Generators write real files. Leaving them behind makes the next run fail
  // with "already exists", which reads as a broken generator.
  for (const path of written.splice(0)) {
    await rm(path, { force: true, recursive: true })
  }
})

describe('running a command', () => {
  it('reports success as an exit code and prints what it did', async () => {
    const run = await artisan(kernel, ['about'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('Environment')
  })

  it('an unknown command fails rather than doing nothing quietly', async () => {
    const run = await artisan(kernel, ['no:such-command'], Output.prototype as never).run()

    run.assertFailed()
  })
})

describe('generators', () => {
  it('write the file they say they wrote', async () => {
    const name = `TestMade${Date.now()}`
    const path = app.basePath('app', 'Enums', `${name}.ts`)
    written.push(path)

    const run = await artisan(kernel, ['make:enum', name], Output.prototype as never).run()

    run.assertSuccessful()
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await Bun.file(path).text()).toContain(`export const ${name}`)
  })

  /**
   * Refusing to overwrite is what makes a generator safe to re-run.
   *
   * A second `make:model User` that silently replaced the one in use would be
   * the most expensive thing in this file.
   */
  it('and refuse to overwrite one that exists', async () => {
    const name = `TestTwice${Date.now()}`
    written.push(app.basePath('app', 'Enums', `${name}.ts`))

    await artisan(kernel, ['make:enum', name], Output.prototype as never).run()
    const second = await artisan(kernel, ['make:enum', name], Output.prototype as never).run()

    second.assertFailed()
    second.assertOutputContains('already exists')
  })

  it('--pretend writes nothing', async () => {
    const name = `TestPretend${Date.now()}`
    const path = app.basePath('app', 'Enums', `${name}.ts`)

    const run = await artisan(
      kernel,
      ['make:enum', name, '--pretend'],
      Output.prototype as never
    ).run()

    run.assertSuccessful()
    expect(await Bun.file(path).exists()).toBe(false)
  })
})

describe('inspection commands', () => {
  it('route:list names a route the application actually has', async () => {
    const run = await artisan(kernel, ['route:list'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('/check/articles')
  })

  /**
   * `config:show` reads the resolved value, not the file.
   *
   * That is the whole reason it exists: `config/queue.ts` says what the file
   * says, and an `env()` call in it means the running value can be different.
   */
  it('config:show prints what the application resolved', async () => {
    const run = await artisan(kernel, ['config:show', 'queue'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('queue.default')
  })

  it('middleware:list names the aliases routes can use', async () => {
    const run = await artisan(kernel, ['middleware:list'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('auth')
  })

  it('model:show reads the class and the table together', async () => {
    const run = await artisan(kernel, ['model:show', 'Article'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('articles')
  })
})

describe('the exit code', () => {
  /**
   * Non-zero is how a scheduler or a CI step finds out.
   *
   * `db:monitor` over its threshold and `queue:monitor` over its size both exit
   * 1 on purpose; a command that printed a warning and exited 0 would be invisible
   * to everything that runs it unattended.
   */
  it('queue:monitor fails when a queue is over its limit', async () => {
    const run = await artisan(
      kernel,
      ['queue:monitor', 'default', '--max=-1'],
      Output.prototype as never
    ).run()

    run.assertFailed()
  })
})
