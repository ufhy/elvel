import { join } from 'node:path'
import type { ApplicationContract } from '@elysian/contracts'
import type { Spawner } from './runner.ts'

/**
 * Run a console command in a child process — what `runInBackground()` needs.
 *
 * The child is this runtime running the application's own `artisan` entry point,
 * which is the only thing a fresh process can be given: a closure cannot travel,
 * but a command name and its arguments can.
 *
 * Output is inherited rather than captured, so a background task's logging still
 * reaches wherever the scheduler's does. Capturing it is what `sendOutputTo`
 * would need, and there is nothing to redirect it to yet.
 */
export function spawner(app: ApplicationContract): Spawner {
  return async ({ name, parameters }) => {
    const entry = app.config.get<string>('schedule.artisan', join(app.basePath(), 'artisan.ts'))

    const child = Bun.spawn([process.execPath, entry, name, ...parameters], {
      cwd: app.basePath(),
      env: process.env,
      stdout: 'inherit',
      stderr: 'inherit'
    })

    return child.exited
  }
}
