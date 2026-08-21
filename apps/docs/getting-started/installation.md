# Installation

One command, and the application it writes is yours — there is nothing to
`eject` from later.

```bash
bun create elvel my-app
cd my-app
bun run dev
```

Then open `http://localhost:3000`.

That is the whole of it. The scaffolder installs the packages, writes an `.env`
with its own generated secrets, and runs the migrations — so there is **no
`key:generate` step and no placeholder key to rotate**, which is the usual way a
development key reaches production.

## Requirements

Bun 1.3 or later, and nothing else. The drivers that ship need no service
running: `cache=file`, `queue=sync`, `mail=log`, `disk=local`, and SQLite. So
`bun run dev` works before Docker does.

## Pick a kit

```bash
bun create elvel my-app --kit=auth
```

| | what it is | providers | dependencies |
|---|---|---:|---:|
| `none` | a landing page, no database | 10 | 14 |
| `auth` | sign in, sign up, a dashboard, settings | 17 | 22 |
| `api` | bearer-token auth, JSON, no auth pages | 16 | 21 |

[Starter kits](/getting-started/starter-kits) has what each one writes. Omit
`--kit` and it asks.

Other flags: `--minimal` is `--kit=none`, `--install` / `--no-install` decide
whether to run `bun install` and the migrations rather than printing the steps,
and `--force` writes into a directory that already has something in it.

## An application installs only what its kit uses

This is the one place Elvel departs from Laravel by necessity. Laravel's
components arrive inside a single Composer package whether or not you touch them;
these are twenty-seven npm packages, and **registering all of them took a landing
page from 1.0 MB to 3.7 MB** — most of it `kysely` behind the database,
`nodemailer` behind mail, and better-auth behind auth.

So `bootstrap/providers.ts` lists what the application registers, and the kit
decides what goes in it. A provider named there is a package imported, installed
and bundled; one left out is a package the application never pays for.

## Adding something later

Three steps, and the framework has all three. A database, which `--kit=none` does
not install:

```bash
bun add @elvel/database
bun elvel config:publish database
```

…then a line in `bootstrap/providers.ts`. After that `make:model`, `migrate` and
the rest are registered — a command exists only if its package does, so
`bun elvel list` is the honest list.

`config:publish` does one thing Laravel's does not need to: it **adds the line to
`bootstrap/app.ts`** as well, because a config file nobody named is configuration
the framework never reads. See [configuration](/getting-started/configuration).

`install:api` and `install:broadcasting` do the same job for those two, which need
a routes file or a config file rather than just a provider.

## Moving a driver off the filesystem

Switching one is an env change plus the migration its own command writes:

```bash
bun elvel cache:table          # then CACHE_STORE=database
bun elvel queue:table          # QUEUE_CONNECTION=database
bun elvel queue:failed-table
bun elvel session:table        # SESSION_DRIVER=database
bun elvel notifications:table
bun elvel migrate
```

The tables are generated rather than shipped so you can read them before they
run, and because what they hold depends on your configuration.

## First commands worth knowing

```bash
bun elvel                      # every command this application has
bun elvel about                # environment, paths, routes, view engine
bun elvel route:list
bun elvel make:model Post -mfs # model + migration + factory + seeder
bun elvel make:controller PostController -r
bun elvel dev                  # server, Vite, a worker and the scheduler
```

[Every command](/reference/commands) is the full list.

## Working inside this repository

A scaffold created **inside the Elvel checkout** becomes a workspace member, and
the scaffolder says so:

```
Created as a workspace member — framework packages link by symlink.
```

That is right for trying a change to the framework, and wrong for testing a
release: a workspace member never resolves a published version, which is exactly
how `1.0.0-alpha.1` shipped with a broken dependency range that no check caught.
`scripts/verify-published.ts` exists for that reason.
