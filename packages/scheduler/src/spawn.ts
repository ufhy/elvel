import { join } from 'node:path'
import type { ApplicationContract } from '@elysian/contracts'
import { ProcessManager } from '@elysian/process'
import type { Spawner } from './runner.ts'

/**
 * Run a console command in a child process — what `runInBackground()` needs.
 *
 * The child is this runtime running the application's own `artisan` entry point,
 * which is the only thing a fresh process can be given: a closure cannot travel,
 * but a command name and its arguments can.
 *
 * Output is inherited unless something asked for it — `sendOutputTo()` or
 * `emailOutputTo()`. Inheriting is the better default: a background task's
 * logging then reaches wherever the scheduler's does, rather than disappearing
 * into a buffer nobody reads.
 *
 * Runs through `@elysian/process` rather than `Bun.spawn` directly, which is
 * what makes the child its own process group: a scheduled command that forks
 * used to leave its children behind when the entry was killed.
 */
export function spawner(app: ApplicationContract): Spawner {
  return async ({ name, parameters }, capture) => {
    const entry = app.config.get<string>('schedule.artisan', join(app.basePath(), 'artisan.ts'))

    const runner = new ProcessManager().path(app.basePath())
    const configured = capture ? runner : runner.inherit()

    const result = await configured.run([process.execPath, entry, name, ...parameters])

    // Both streams, because a task that fails usually explains itself on stderr
    // and a caller emailing the output wants that half most of all.
    return capture ? { code: result.exitCode, output: result.all() } : { code: result.exitCode }
  }
}
