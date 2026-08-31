import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * `better-auth` is built when an auth route is reached, not when the package is
 * imported.
 *
 * It costs 65ms to evaluate, and `config/app.ts` names the provider whether or not
 * a request ever reaches `/api/auth` — so every CLI command and every boot paid it
 * for something they would not use. The provider's `instance()` was already async
 * and already the only caller.
 *
 * A subprocess, because the module registry is shared with every other test file:
 * run after anything that builds an auth instance, an in-process check would see
 * `better-auth` already loaded and fail for the wrong reason.
 */
const ask = async (body: string): Promise<string> => {
  const src = join(import.meta.dir, '..', 'src')

  const script = `
// Separators normalised: a module path is backslash-separated on Windows, and
// matching '/juice/' there found nothing whether it was loaded or not.
const loaded = (fragment) => Object.keys(require.cache ?? {}).some((path) => path.replaceAll('\\\\', '/').includes(fragment))
const src = ${JSON.stringify(src)}
${body}
`
  const file = join(import.meta.dir, `.lazy-${crypto.randomUUID()}.ts`)

  await Bun.write(file, script)

  try {
    const run = Bun.spawn(['bun', file], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe'
    })

    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited
    ])

    /**
     * A subprocess that did not run is not the same as a module that was loaded,
     * and comparing its empty output to `'false'` says neither. This failed on
     * somebody else's machine and reported nothing but `expected 'false', got ''`,
     * which is the whole reason this check is here.
     */
    if (code !== 0) {
      throw new Error(`The probe exited ${code} instead of answering:\n${err.trim() || out.trim()}`)
    }

    return out.trim()
  } finally {
    await Bun.file(file).delete()
  }
}

describe('importing the auth package', () => {
  test('does not evaluate better-auth', async () => {
    const answer = await ask(`
      await import(src + '/index.ts')
      console.log(loaded('/better-auth/'))
    `)

    expect<string>(answer).toBe('false')
  })

  /** Nor the adapter factory, which is reached only when the instance is built. */
  test('and does not evaluate its adapter factory', async () => {
    const answer = await ask(`
      const { elvelAdapter } = await import(src + '/adapter.ts')
      console.log([typeof elvelAdapter, loaded('/better-auth/')].join(','))
    `)

    expect<string>(answer).toBe('function,false')
  })
})
