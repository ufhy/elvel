import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Application } from '@elvel/core'
import { HttpServiceProvider } from '../src/provider.ts'
import { resetRouter } from '../src/router/registrar.ts'

/**
 * A routes file that exports nothing — `routes/web.php`, in TypeScript.
 *
 * This is the whole point of the layer: the file reads like Laravel's, and
 * `withRoutes` finds what it declared through the compiler `HttpServiceProvider`
 * binds. Written to disk and imported for real rather than faked, because what is
 * being tested is the import path itself.
 */
describe('a routes file with no default export', () => {
  test('is mounted anyway, through routes.compiler', async () => {
    resetRouter()

    const root = await mkdtemp(join(tmpdir(), 'elvel-bare-routes-'))
    const file = join(root, 'web.ts')

    await writeFile(
      file,
      `import { Route } from '${pathToFileURL(join(import.meta.dir, '..', 'src', 'index.ts')).href}'

Route.get('/hello', () => 'hello from a bare file').name('hello')
Route.fallback(() => 'nothing else claimed it')
`
    )

    const app = await Application.configure(root)
      .withProviders([HttpServiceProvider])
      .withRoutes(() => import(pathToFileURL(file).href) as never)
      .create()

    expect<string>(await (await app.handle(new Request('http://localhost/hello'))).text()).toBe(
      'hello from a bare file'
    )
    expect<string>(await (await app.handle(new Request('http://localhost/anything'))).text()).toBe(
      'nothing else claimed it'
    )
    expect<string | undefined>(app.make('routes').path('hello')).toBe('/hello')
  })
})
