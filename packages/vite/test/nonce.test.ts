import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withRequestScope } from '@elvel/http'
import { Vite } from '../src/tags.ts'

/**
 * A harvested tag can be inline, and an inline script needs the request's nonce.
 *
 * Every tag this package writes itself carries `src` or `href`, which
 * `script-src 'self'` allows on its own. The ones it *harvests* are another
 * plugin's markup, and `@vitejs/plugin-react`'s Fast Refresh preamble is inline —
 * so without a nonce the policy this framework sends refuses it. Nothing fails on
 * the server: the browser logs a violation and Fast Refresh quietly becomes a full
 * reload, which is the very symptom the harvesting exists to fix.
 *
 * The plugin cannot write the nonce itself. It renders its tag during the build or
 * the dev-server handshake, long before the request that will carry one.
 */
describe('the nonce on harvested tags', () => {
  const build = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), 'elvel-vite-nonce-'))

    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true })
      await Bun.write(join(root, name), contents)
    }

    return root
  }

  const inScope = <T>(nonce: string, body: () => T): T =>
    withRequestScope({ request: new Request('http://localhost/'), nonce } as never, body)

  test('an inline script gets the one this request carries', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'hot-tags.txt': '<script type="module">preamble()</script>'
    })

    const tags = inScope('n0nc3==', () => new Vite({ publicPath: root }).tags('app.ts'))

    expect<boolean>(
      tags.includes('<script nonce="n0nc3==" type="module">preamble()</script>')
    ).toBe(true)
  })

  test('and a plugin that already wrote one keeps it', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'hot-tags.txt': '<script nonce="theirs">knows()</script>'
    })

    const tags = inScope('ours', () => new Vite({ publicPath: root }).tags('app.ts'))

    expect<boolean>(tags.includes('nonce="theirs"')).toBe(true)
    expect<boolean>(tags.includes('nonce="ours"')).toBe(false)
  })

  /**
   * Outside a request there is no nonce, and an empty attribute is worse than none.
   *
   * `cspNonce()` answers `''` with the policy off and anywhere there is no request —
   * a test, a build script — and `nonce=""` matches nothing in a policy, so a page
   * written to work without CSP would stop working with it.
   */
  test('nothing is added when no policy is being sent', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'hot-tags.txt': '<script type="module">preamble()</script>'
    })

    const tags = new Vite({ publicPath: root }).tags('app.ts')

    expect<boolean>(tags.includes('nonce')).toBe(false)
    expect<boolean>(tags.includes('<script type="module">preamble()</script>')).toBe(true)
  })

  test('a harvested link is left alone', async () => {
    const root = await build({
      'build/manifest.json': JSON.stringify({ 'app.ts': { file: 'assets/app-abc123.js' } }),
      'build/injected-tags.txt': '<link rel="manifest" href="/build/manifest.webmanifest">'
    })

    const tags = inScope('n0nc3', () => new Vite({ publicPath: root }).tags('app.ts'))

    expect<boolean>(tags.includes('<link rel="manifest" href="/build/manifest.webmanifest">')).toBe(
      true
    )
  })

  /** A tag whose name merely begins with `script` is not a script. */
  test('and a name that only starts with script is not one', async () => {
    const root = await build({
      hot: 'http://localhost:5173\n',
      'hot-tags.txt': '<scriptish data-x="1"></scriptish>'
    })

    const tags = inScope('n0nc3', () => new Vite({ publicPath: root }).tags('app.ts'))

    expect<boolean>(tags.includes('<scriptish data-x="1">')).toBe(true)
  })
})
