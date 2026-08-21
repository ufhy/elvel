import { afterEach, describe, expect, test as it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Output } from '@elvel/console'
import { elvel } from '@elvel/testing'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * Elvel commands, run in the application rather than shelled out to.
 *
 * `elvel()` drives the same kernel `bun elvel.ts` does, so a command that
 * needs a booted container gets one — and the exit code, the output and any
 * prompt are all assertable. Spawning a process instead would test that Bun can
 * start, and would hide the exit code behind a shell.
 */
const kernel = app.make('elvel')
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
    const run = await elvel(kernel, ['about'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('Environment')
  })

  it('an unknown command fails rather than doing nothing quietly', async () => {
    const run = await elvel(kernel, ['no:such-command'], Output.prototype as never).run()

    run.assertFailed()
  })
})

describe('generators', () => {
  it('write the file they say they wrote', async () => {
    const name = `TestMade${Date.now()}`
    const path = app.basePath('app', 'Enums', `${name}.ts`)
    written.push(path)

    const run = await elvel(kernel, ['make:enum', name], Output.prototype as never).run()

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

    await elvel(kernel, ['make:enum', name], Output.prototype as never).run()
    const second = await elvel(kernel, ['make:enum', name], Output.prototype as never).run()

    second.assertFailed()
    second.assertOutputContains('already exists')
  })

  it('--pretend writes nothing', async () => {
    const name = `TestPretend${Date.now()}`
    const path = app.basePath('app', 'Enums', `${name}.ts`)

    const run = await elvel(
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
    const run = await elvel(kernel, ['route:list'], Output.prototype as never).run()

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
    const run = await elvel(kernel, ['config:show', 'queue'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('queue.default')
  })

  it('middleware:list names the aliases routes can use', async () => {
    const run = await elvel(kernel, ['middleware:list'], Output.prototype as never).run()

    run.assertSuccessful()
    run.assertOutputContains('auth')
  })

  it('model:show reads the class and the table together', async () => {
    const run = await elvel(kernel, ['model:show', 'Article'], Output.prototype as never).run()

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
    const run = await elvel(
      kernel,
      ['queue:monitor', 'default', '--max=-1'],
      Output.prototype as never
    ).run()

    run.assertFailed()
  })
})

/**
 * `model:prune`, which reads `prunable()` off models on disk.
 *
 * It can only be exercised in an application, and until this test existed it had
 * none — while being able to delete rows. Two bugs came out of writing it:
 *
 * - `{--model=*}` is Laravel's spelling for a repeatable option and was read as a
 *   default of `"*"`, so every model was filtered out and the command reported
 *   `No model defines prunable()` against an application whose model defined one.
 * - `--pretend` returned after the first batch, so it reported the chunk size
 *   rather than the total: `--chunk=2` against four expired rows said two, and
 *   deleting removed four. Under-reporting on the flag whose purpose is deciding
 *   whether to run the real thing is the wrong direction to be wrong in.
 */
describe('model:prune', () => {
  const kernel = app.make('elvel')

  const spam = async (count: number) => {
    const { Article } = await import('../app/Models/Article.ts')
    const { Comment } = await import('../app/Models/Comment.ts')

    const article = await Article.create({
      title: 'Prunable',
      slug: `prunable-${Date.now()}-${Math.round(performance.now() * 1000)}`,
      body: 'Long enough to be a body, comfortably past any minimum.'
    })

    for (let n = 0; n < count; n += 1) {
      await Comment.create({ article_id: article.id, author: 'spam', body: `spam ${n}` })
    }

    return Comment
  }

  it('pretends the whole total, whatever the chunk size', async () => {
    const Comment = await spam(4)

    try {
      const command = await elvel(
        kernel,
        ['model:prune', '--pretend', '--chunk=2'],
        Output.prototype
      ).run()

      command.assertSuccessful().assertOutputContains('4 row(s) would be pruned')

      // And pretending really pretended.
      expect(await Comment.query().where('author', 'spam').count()).toBe(4)
    } finally {
      await Comment.query().where('author', 'spam').delete()
    }
  })

  it('deletes what prunable() returns, in chunks', async () => {
    const Comment = await spam(3)

    const command = await elvel(kernel, ['model:prune', '--chunk=2'], Output.prototype).run()

    command.assertSuccessful().assertOutputContains('3 row(s) pruned')

    expect(await Comment.query().where('author', 'spam').count()).toBe(0)
  })

  it('--model names one, and the name has to match', async () => {
    const Comment = await spam(2)

    try {
      const only = await elvel(
        kernel,
        ['model:prune', '--pretend', '--model=Comment'],
        Output.prototype
      ).run()

      only.assertSuccessful().assertOutputContains('2 row(s) would be pruned')

      const none = await elvel(
        kernel,
        ['model:prune', '--pretend', '--model=Article'],
        Output.prototype
      ).run()

      // Article defines no prunable(), so naming it prunes nothing.
      none.assertSuccessful().assertOutputContains('No model defines prunable()')
    } finally {
      await Comment.query().where('author', 'spam').delete()
    }
  })
})
