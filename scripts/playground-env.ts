import { join, resolve } from 'node:path'

/**
 * Give the playground an environment, without keeping one in git.
 *
 * `playground/.env` was committed so CI would have one — which made this
 * repository do the thing it tells every application never to do, and would have
 * put a `.env` on display the moment the repository went public. It held nothing
 * secret: it was byte-identical to `playground/.env.example`, so a copy is all it
 * ever was.
 *
 * Without it the playground boots with no `APP_KEY`, sessions switch off, and
 * fifteen tests fail — encryption, cookies, CSRF, flash data, and the pages that
 * need a session to render.
 *
 * Imported for its effect rather than called, because of *when* it has to run.
 * A playground test imports `bootstrap/app.ts` on its first line, and by then the
 * configuration has been read; so this is a `preload` in `bunfig.toml`, which Bun
 * evaluates before any test file. `scripts/smoke.ts` imports it directly for the
 * same reason, above its own import of the application.
 */
const environment = resolve(import.meta.dir, '..', 'playground', '.env')

if (!(await Bun.file(environment).exists())) {
  const example = join(`${environment}.example`)

  await Bun.write(environment, await Bun.file(example).text())
}
