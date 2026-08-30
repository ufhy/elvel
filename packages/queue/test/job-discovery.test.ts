import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobRegistry } from '../src/job.ts'

/**
 * `app/Jobs` is read when a job is asked for by name, not when the process starts.
 *
 * Discovery used to run inside `boot()`, so every process imported every job file
 * — `elvel key:generate` as much as a worker. On the playground that is 4.7ms,
 * because its jobs import only what the framework has already loaded. **A single
 * job file that imports a dependency of its own costs 185ms**, measured with one
 * that pulls `juice` and `nodemailer`, and a real application's jobs are full of
 * PDF renderers and storage clients that nothing else touches.
 *
 * Almost nothing needs the directory read: dispatching a job registers its own
 * class on the way past, so the only caller that resolves a name it has never seen
 * is a worker rebuilding a job from a payload.
 *
 * What it costs is where a broken job file surfaces — at the first lookup that
 * misses, rather than at boot.
 */
class Alpha {
  handle(): void {}
}

class Beta {
  handle(): void {}
}

describe('a registry with somewhere to look', () => {
  const registry = (found: Array<typeof Alpha> = [Alpha, Beta]) => {
    let runs = 0
    const jobs = new JobRegistry().discoverWith(async () => {
      runs += 1

      return found as never
    })

    return { jobs, runs: () => runs }
  }

  test('does not look until something is missing', async () => {
    const { jobs, runs } = registry()

    jobs.register(Alpha as never)

    expect<unknown>(await jobs.find('Alpha')).toBe(Alpha)
    expect<number>(runs()).toBe(0)
  })

  test('and looks when it is', async () => {
    const { jobs, runs } = registry()

    expect<unknown>(await jobs.find('Beta')).toBe(Beta)
    expect<number>(runs()).toBe(1)
  })

  /**
   * A second miss is a job that does not exist. Re-reading the directory to be told
   * so again would turn a typo in a payload into a scan per failed job.
   */
  test('once, even when the name is not there', async () => {
    const { jobs, runs } = registry()

    expect<unknown>(await jobs.find('Nothing')).toBeUndefined()
    expect<unknown>(await jobs.find('Nothing')).toBeUndefined()
    expect<unknown>(await jobs.find('Alpha')).toBe(Alpha)
    expect<number>(runs()).toBe(1)
  })

  test('and never twice when two lookups race', async () => {
    const { jobs, runs } = registry()

    await Promise.all([jobs.find('Alpha'), jobs.find('Beta'), jobs.find('Alpha')])

    expect<number>(runs()).toBe(1)
  })

  /** `names()` reports what is registered; `all()` is the one that goes looking. */
  test('names reports what it holds, all reports what exists', async () => {
    const { jobs } = registry()

    jobs.register(Alpha as never)

    expect<string[]>(jobs.names()).toEqual(['Alpha'])
    expect<string[]>(await jobs.all()).toEqual(['Alpha', 'Beta'])
    expect<string[]>(jobs.names()).toEqual(['Alpha', 'Beta'])
  })

  test('and a registry with nowhere to look still answers', async () => {
    const jobs = new JobRegistry()

    jobs.register(Alpha as never)

    expect<unknown>(await jobs.find('Alpha')).toBe(Alpha)
    expect<unknown>(await jobs.find('Beta')).toBeUndefined()
    expect<string[]>(await jobs.all()).toEqual(['Alpha'])
  })
})

describe('the provider hands the directory over rather than reading it', () => {
  /**
   * The property that matters is that `boot()` does not import `app/Jobs`. Asked
   * in a subprocess with a job file that announces itself when evaluated, because
   * an in-process check would be answering about whatever earlier tests loaded.
   */
  const boot = async (thenLookUp: boolean): Promise<string> => {
    const root = join(tmpdir(), `elvel-jobs-${crypto.randomUUID()}`)

    await Bun.write(
      join(root, 'app', 'Jobs', 'Announcing.ts'),
      `console.log('imported')
export class Announcing {
  async handle() {}
}
`
    )

    const script = `
import { Application } from '@elvel/core'
import { EventServiceProvider } from '@elvel/events'
import { QueueServiceProvider } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'index.ts'))}

const app = new Application(${JSON.stringify(root)})
app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'T' })
app.config.set('queue', { default: 'sync', connections: { sync: { driver: 'sync' } } })

await app.register(EventServiceProvider)
await app.register(QueueServiceProvider)
await app.boot()

${thenLookUp ? "console.log(((await app.make('queue').jobs.find('Announcing')) !== undefined) ? 'found' : 'missing')" : "console.log('booted')"}
`
    // Inside the repository, not beside the fake application: a script in a
    // temporary directory resolves `@elvel/core` to whatever npm has cached rather
    // than to the workspace, and boots a different framework than the one on trial.
    const file = join(import.meta.dir, `.discovery-${crypto.randomUUID()}.ts`)

    await Bun.write(file, script)

    const run = Bun.spawn(['bun', file], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    const out = (await new Response(run.stdout).text()).trim()

    await rm(root, { recursive: true, force: true })
    await Bun.file(file).delete()

    return out
  }

  test('so booting imports no job file', async () => {
    expect<string>(await boot(false)).toBe('booted')
  })

  test('and the first lookup by name imports them all', async () => {
    expect<string>(await boot(true)).toBe('imported\nfound')
  })
})
