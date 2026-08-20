# Configuration

Configuration is TypeScript, not YAML or `.php` — files under `config/`, each
exporting a plain object, read once at boot.

```ts
// config/app.ts
import { Env } from '@elvel/core'

export default {
  name: Env.string('APP_NAME', 'Elvel'),
  env: Env.string('APP_ENV', 'production'),
  debug: Env.boolean('APP_DEBUG', false),
  url: Env.string('APP_URL', 'http://localhost:3000'),
  port: Env.number('PORT', 3000)
}
```

Read it back with dot notation, from anywhere:

```ts
config('app.name')
config('database.connections.mysql.host', '127.0.0.1')  // with a fallback
```

## `Env` is typed, and refuses nonsense

`process.env` is all strings, which is how `APP_DEBUG=false` ends up switching
debugging *on*. `Env.boolean` reads `true`, `(true)`, `on` and `yes` as true, and
`false`, `(false)`, `off` and `no` as false — the parenthesised forms because
Laravel's `.env` parser accepts them. `Env.number` falls back rather than handing
you a `NaN`. `null`, `(null)`, `nil` and an empty value all read as absent, so a
key that is present but blank behaves like a key that is missing.

## An application names its own config files

`bootstrap/app.ts` lists them:

```ts
export default await Application.configure(join(import.meta.dir, '..'))
  .withConfig({
    app: () => import('../config/app.ts'),
    session: () => import('../config/session.ts')
    // … one line per file
  })
```

Lazy imports, and literal ones. Lazy so a config file can call `storage_path()`
while it is being evaluated; literal because **a bundler can follow an `import`
and cannot follow a directory read at run time**. Laravel needs no equivalent —
PHP resolves `config/*.php` from disk on every request and there is no build step
to hide the directory from.

Here there is, and getting it wrong was not subtle: left to scan `config/`, a
bundled application loaded a *second copy of the framework* through those
resolved paths, so `Application.current` belonged to the copy that was not
running. Naming the files is what makes `bun run build:server` honest — and what
lets it drop the packages a kit does not use.

## Not every config file ships

A scaffolded application gets the files its kit actually needs — nine for
`--kit=none`, sixteen for `--kit=auth` — rather than all nineteen. Laravel 11
slimmed its skeleton the same way for the same reason: a file you have never
opened is a file you cannot reason about.

Fetch the rest when you want them:

```bash
bun elvel config:publish            # asks which one
bun elvel config:publish mail
bun elvel config:publish --all
```

Two things it does that Laravel's does not have to. It **warns when the package
is not installed** — publishing `mail` into an application with no
`@elvel/mail` is a question with a real answer, not a missing file. And it
**adds the line to `bootstrap/app.ts`**, because a published file nobody named
would be configuration the framework never reads: present, correct, and silently
ignored.

## Secrets stay in `.env`

`.env` is not committed; `.env.example` is. `bun elvel key:generate` writes
`APP_KEY`, which the encrypter and the session need — without it sessions switch
themselves off rather than pretending to be secure.
