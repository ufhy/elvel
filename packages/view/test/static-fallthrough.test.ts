import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '@elvel/core'
import { ViewServiceProvider } from '../src/provider.ts'

/**
 * A request for a file that is not there belongs to the router.
 *
 * This is the shape Laravel has and it is not a preference: its nginx
 * configuration is `try_files $uri $uri/ /index.php?$query_string` and Valet's
 * `isStaticFile()` is `file_exists(...) ? path : false`. The file if it exists,
 * the application if it does not — so `Route::view('{path}', 'main')` works, and
 * a static layer never answers a 404 of its own.
 *
 * Elvel got that wrong for one environment. `@elysiajs/static` with
 * `alwaysStatic: false` resolves per request, and to do that it claims `/*` and
 * answers its own misses — which beats every route registered after it. The
 * result was routing that depended on `APP_ENV`: an application whose only
 * catch-all was `.get('/*')` answered `/deep/link` in production and **404 in
 * development**, from the same source.
 *
 * These tests run the same application in both environments and expect the same
 * answers.
 */
const root = mkdtempSync(join(tmpdir(), 'elvel-fallthrough-'))

writeFileSync(join(root, 'favicon.svg'), '<svg />')
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'app-abc123.js'), 'export const value = 1\n')

/**
 * The application under test: two real routes and a catch-all, as an application
 * serving a client-side router has.
 */
async function serve(environment: 'local' | 'production'): Promise<Application> {
  const app = new Application(process.cwd())

  app.config.set('app.env', environment)
  app.config.set('view.publicPath', root)

  await app.register(ViewServiceProvider)
  await app.boot()

  app.router
    .get('/health', () => ({ status: 'ok' }))
    .get('/', () => new Response('<h1>home</h1>', { headers: { 'content-type': 'text/html' } }))
    .get('/*', () => new Response('<h1>client</h1>', { headers: { 'content-type': 'text/html' } }))

  return app
}

for (const environment of ['local', 'production'] as const) {
  describe(`serving static files in ${environment}`, () => {
    test('an address with no file falls through to the catch-all', async () => {
      const app = await serve(environment)

      const response = await app.handle(new Request('http://localhost/deep/link'))

      expect<number>(response.status).toBe(200)
      expect<string>(await response.text()).toBe('<h1>client</h1>')
    })

    test('a file that exists still wins over the catch-all', async () => {
      const app = await serve(environment)

      const response = await app.handle(new Request('http://localhost/favicon.svg'))

      expect<number>(response.status).toBe(200)
      expect<string>(await response.text()).toBe('<svg />')
    })

    test('and so does one under the build directory', async () => {
      const app = await serve(environment)

      const response = await app.handle(new Request('http://localhost/build/app-abc123.js'))

      expect<number>(response.status).toBe(200)
      expect<string>(await response.text()).toBe('export const value = 1\n')
    })

    test('a real route is not shadowed by any of it', async () => {
      const app = await serve(environment)

      expect<string>(await (await app.handle(new Request('http://localhost/'))).text()).toBe(
        '<h1>home</h1>'
      )
      expect<unknown>(
        await (await app.handle(new Request('http://localhost/health'))).json()
      ).toEqual({ status: 'ok' })
    })

    /**
     * The reason the plugin used to resolve per request, still covered.
     *
     * `alwaysStatic: true` builds its route table once, so this file is not in
     * it. `compressedAssets` is mounted ahead of the plugin as an `onRequest`
     * that stats the path per request and answers everything it can resolve —
     * which is what makes a table computed at boot cost nothing here.
     */
    test('a file written after boot is served without a restart', async () => {
      const app = await serve(environment)
      const path = join(root, `after-boot-${environment}.txt`)

      writeFileSync(path, 'written later\n')

      try {
        const response = await app.handle(
          new Request(`http://localhost/after-boot-${environment}.txt`)
        )

        expect<number>(response.status).toBe(200)
        expect<string>(await response.text()).toBe('written later\n')
      } finally {
        rmSync(path, { force: true })
      }
    })
  })
}
