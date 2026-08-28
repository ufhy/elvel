import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { ViewServiceProvider } from '@elvel/view'
import { ViteServiceProvider } from '../src/provider.ts'

/**
 * A service worker is refused unless the server says how far it may reach.
 *
 * A worker may claim no more than the directory it is served from, and Vite writes
 * it into the build directory — so `/build/sw.js` controls `/build/` and nothing
 * else, which is every address a client-routed application actually uses. Measured
 * in Chromium against a scaffolded application: *"The path of the provided scope
 * ('/') is not under the max scope allowed ('/build/'). Adjust the scope, move the
 * Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the
 * scope."*
 *
 * Of those three remedies only the header leaves the build output where the build
 * put it, and only a server can send one — which is why a config key here decides
 * it rather than the Vite plugin that wrote the file.
 */
const root = mkdtempSync(join(tmpdir(), 'elvel-service-worker-'))

mkdirSync(join(root, 'build', 'assets'), { recursive: true })
writeFileSync(join(root, 'build', 'sw.js'), 'self.addEventListener("install", () => {})\n')
writeFileSync(join(root, 'build', 'registerSW.js'), 'navigator.serviceWorker.register("/sw.js")\n')
writeFileSync(join(root, 'build', 'assets', 'app-a1b2c3.js'), 'export const value = 1\n')

async function serve(worker: string | false): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app.env', 'production')
  app.config.set('view.publicPath', root)
  app.config.set('vite.serviceWorker', worker)

  /**
   * `ViteServiceProvider` **after** the view provider, as an application registers
   * them — which is the reason the headers arrive as a container binding rather
   * than as a hook of its own. The static layer answers a file that exists before
   * any later hook sees the request.
   */
  await app.register(ViewServiceProvider)
  await app.register(ViteServiceProvider)
  await app.boot()

  return app
}

const header = async (app: Application, path: string, name: string) =>
  (await app.handle(new Request(`http://localhost${path}`))).headers.get(name)

describe('the service worker header', () => {
  test('names the whole site as the scope it may claim', async () => {
    const app = await serve('sw.js')

    expect<string | null>(await header(app, '/build/sw.js', 'service-worker-allowed')).toBe('/')
  })

  /**
   * And the header that keeps the *next* worker reachable.
   *
   * `sw.js` carries no content hash, so nothing about its name changes when it
   * does. Under the year-long `immutable` the build directory used to get whole, an
   * application would have frozen at its first deployed worker with nothing failing
   * anywhere.
   */
  test('and tells the browser to revalidate it rather than keep it', async () => {
    const app = await serve('sw.js')

    expect<string | null>(await header(app, '/build/sw.js', 'cache-control')).toBe('no-cache')
  })

  test('for that one file and nothing else under the build', async () => {
    const app = await serve('sw.js')

    expect<string | null>(
      await header(app, '/build/registerSW.js', 'service-worker-allowed')
    ).toBeNull()

    expect<string | null>(
      await header(app, '/build/assets/app-a1b2c3.js', 'service-worker-allowed')
    ).toBeNull()
  })

  /**
   * A hashed asset keeps the year it earned.
   *
   * The narrowed prefix is the fix for the worker, and it must not cost the assets
   * the caching that made it worth having: a navigation was re-downloading every
   * one of them before that existed.
   */
  test('while a hashed asset is still immutable for a year', async () => {
    const app = await serve('sw.js')

    expect<string | null>(await header(app, '/build/assets/app-a1b2c3.js', 'cache-control')).toBe(
      'public, max-age=31536000, immutable'
    )
  })

  /** Off by default: a header naming a scope should not be sent for no file. */
  test('and nothing is sent when no worker is named', async () => {
    const app = await serve(false)

    expect<string | null>(await header(app, '/build/sw.js', 'service-worker-allowed')).toBeNull()
    expect<string | null>(await header(app, '/build/sw.js', 'cache-control')).toBe(
      'public, max-age=86400'
    )
  })
})
