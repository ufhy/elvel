import { describe, expect, test } from 'bun:test'
import { Application, defer, deferredCount } from '@elvel/core'
import { Command } from '../src/command.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * A command is a unit of work, so its deferred work runs when it finishes.
 *
 * `flushDeferred`'s own docstring claimed this already happened — "called by the
 * http layer once the response is out, **and by the console kernel when a
 * command finishes**" — and the second half was not true. `flushDeferred` had
 * exactly one caller in the workspace, in `@elvel/http`. So `defer()` inside a
 * command pushed onto the process-wide array nothing drains: the callback never
 * ran, the command reported success, and the process exited with the work still
 * queued.
 *
 * Measured before it was fixed, with a command that deferred a line and never
 * printed it.
 */

/** What the deferred callbacks recorded. */
const flushed: string[] = []

class Deferring extends Command {
  static override signature = 'probe:defer'
  static override description = 'Defer a callback and finish'

  handle(): number {
    defer(() => {
      flushed.push('deferred')
    })

    flushed.push(`queued:${deferredCount()}`)

    return 0
  }
}

class DeferringAndFailing extends Command {
  static override signature = 'probe:defer-fail'
  static override description = 'Defer a callback and then throw'

  handle(): number {
    defer(() => {
      flushed.push('deferred')
    })

    throw new Error('nope')
  }
}

function kernel(...commands: Array<typeof Command>): Kernel {
  const app = new Application(process.cwd())
  app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })

  const built = new Kernel(app)

  built.register(...(commands as never[]))

  return built
}

describe('deferred work in a console command', () => {
  test('runs when the command finishes', async () => {
    flushed.length = 0

    const code = await kernel(Deferring).run(['probe:defer'])

    expect<number>(code).toBe(0)
    expect<string[]>(flushed).toEqual(['queued:1', 'deferred'])
  })

  /**
   * Including when the command failed.
   *
   * It still deferred what it deferred, and dropping that because the command
   * returned 1 is a second failure hidden behind the first — which is why the
   * flush is in a `finally`.
   */
  test('runs even when the command throws', async () => {
    flushed.length = 0

    const code = await kernel(DeferringAndFailing).run(['probe:defer-fail'])

    expect<number>(code).toBe(1)
    expect<string[]>(flushed).toEqual(['deferred'])
  })

  test('starts each command with an empty queue', async () => {
    flushed.length = 0

    const built = kernel(Deferring)

    await built.run(['probe:defer'])
    await built.run(['probe:defer'])

    // `queued:1` twice, not `queued:1` then `queued:2`.
    expect<string[]>(flushed).toEqual(['queued:1', 'deferred', 'queued:1', 'deferred'])
  })
})
