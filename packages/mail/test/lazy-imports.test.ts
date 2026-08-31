import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * The heavy dependencies are loaded when they are used, not when the package is.
 *
 * `config/app.ts` names every provider, so importing it pulls in every framework
 * package at parse time — and `@elvel/mail` was 161ms of that, almost all of it
 * `juice` (62ms) and `nodemailer` (18ms) evaluating their module bodies.
 * `elvel key:generate` was loading a CSS inliner and an SMTP client. Importing the
 * whole config went from 259ms to 75ms once these two waited to be asked for.
 *
 * Asked in a **subprocess**, because the question is about a module registry and
 * this one is shared with every other test file: run after anything that renders a
 * mail, an in-process check would see `juice` already loaded and fail for a reason
 * that has nothing to do with the property. Found by running it, not by thinking
 * about it.
 *
 * The property rather than a duration: a timing test would be flaky and would not
 * say *what* regressed.
 */
const ask = async (body: string): Promise<string> => {
  // Absolute, because the script is written beside this file rather than at the
  // package root, and a relative specifier would resolve against the wrong one.
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

describe('importing the mail package', () => {
  test('does not evaluate the CSS inliner', async () => {
    const answer = await ask(`
      await import(src + '/index.ts')
      console.log(loaded('/juice/'))
    `)

    expect<string>(answer).toBe('false')
  })

  test('and does not evaluate the SMTP client', async () => {
    const answer = await ask(`
      await import(src + '/index.ts')
      console.log(loaded('/nodemailer/'))
    `)

    expect<string>(answer).toBe('false')
  })

  /** Lazy is only acceptable if it still arrives. */
  test('but rendering a mail loads the inliner and inlines with it', async () => {
    const answer = await ask(`
      const { inlineTheme } = await import(src + '/theme.ts')
      const html = inlineTheme('<p>hello</p>', 'p { color: red }')
      console.log([html.includes('color: red'), loaded('/juice/')].join(','))
    `)

    expect<string>(answer).toBe('true,true')
  })

  test('and a second render answers the same way', async () => {
    const { inlineTheme } = await import('../src/theme.ts')

    expect<boolean>(inlineTheme('<p>a</p>', 'p { color: red }').includes('color: red')).toBe(true)
    expect<boolean>(inlineTheme('<p>b</p>', 'p { color: blue }').includes('color: blue')).toBe(true)
  })
})
