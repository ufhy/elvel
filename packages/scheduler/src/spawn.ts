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
 * Output is inherited unless something asked for it — `sendOutputTo()` or
 * `emailOutputTo()`. Inheriting is the better default: a background task's
 * logging then reaches wherever the scheduler's does, rather than disappearing
 * into a buffer nobody reads.
 */
export function spawner(app: ApplicationContract): Spawner {
  return async ({ name, parameters }, capture) => {
    const entry = app.config.get<string>('schedule.artisan', join(app.basePath(), 'artisan.ts'))

    const child = Bun.spawn([process.execPath, entry, name, ...parameters], {
      cwd: app.basePath(),
      env: process.env,
      stdout: capture ? 'pipe' : 'inherit',
      stderr: capture ? 'pipe' : 'inherit'
    })

    if (!capture) return { code: await child.exited }

    // Both streams, read before waiting: a child that fills the pipe buffer
    // blocks on write, and waiting for it first would deadlock.
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])

    return { code, output: `${out}${err}` }
  }
}
