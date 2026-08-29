# Every command

All of them, as `bun elvel list` prints them. A command exists **only if its
package is registered**, so this is the framework's full set and your
application's list is the honest one:

```bash
bun elvel list
bun elvel <command> --help
```

`--isolated` on a command that allows it runs only if no other copy holds the
lock — see [the console page](/digging-deeper/console#isolated).

## Running things

| Command | |
| --- | --- |
| `serve` | Serve the application |
| `dev` | Server (`--hot`), Vite, a queue worker and the scheduler, in one terminal |
| `about` | Environment, paths, registered routes, view engine |
| `env` | Which environment this is |
| `ping` | Replies, to prove command discovery works |

## Making things

`make:cast` · `make:channel` · `make:class` · `make:command` · `make:component` ·
`make:config` · `make:controller` · `make:enum` · `make:event` ·
`make:exception` · `make:factory` · `make:interface` · `make:job` ·
`make:job-middleware` · `make:listener` · `make:mail` · `make:middleware` ·
`make:migration` · `make:model` · `make:notification` · `make:observer` ·
`make:policy` · `make:provider` · `make:request` · `make:resource` · `make:rule` ·
`make:scope` · `make:seeder` · `make:test` · `make:view`

Every one reads a stub, and the stubs are yours: `stub:publish --list` shows what
would be published and from where.

`make:controller -r` adds CRUD routes.

## Database

| Command | |
| --- | --- |
| `migrate` | Run the pending migrations |
| `migrate:status` | Which have run |
| `migrate:rollback` | Reverse the last batch |
| `migrate:reset` | Reverse every migration |
| `migrate:refresh` | Reverse and re-run |
| `migrate:fresh` | **Drop every table** and re-run |
| `migrate:install` | Create the tracking table by itself |
| `db` | Open a database CLI session |
| `db:seed` | Run the seeders |
| `db:show` | The tables |
| `db:table` | The columns of one |
| `db:wipe` | **Drop every table**, no migrations |
| `db:monitor` | How many connections each database has open |
| `schema:dump` | Write the current schema to a file |
| `model:show` | A model, its table and its columns |
| `model:prune` | Delete records a model says are no longer needed |

Three of those are worth a second look.

**`db:monitor`** takes `--max` and `--json`, so it is a health check rather than
a curiosity: over the threshold it fails, and a scheduled entry can page you.
Remember a Bun SQL connection is a **pool** — `new SQL()` opens ten by default,
so anything counting connections has to allow for its own.

**`schema:dump --prune`** replaces the migration files it folds in. That is what
keeps a five-year-old application from running four hundred migrations to build a
test database.

**`model:prune --pretend`** reports what it *would* delete. Run that first, every
time.

## Cache, queue, schedule

| | |
| --- | --- |
| `cache:clear` · `cache:forget` · `cache:prune` · `cache:table` | [Cache](/digging-deeper/cache#commands) |
| `queue:work` · `queue:listen` · `queue:restart` · `queue:pause` · `queue:resume` · `queue:size` · `queue:monitor` · `queue:clear` | [Queues](/digging-deeper/queues#running-workers) |
| `queue:failed` · `queue:retry` · `queue:forget` · `queue:flush` · `queue:retry-batch` · `queue:prune-batches` | Failures and batches |
| `queue:table` · `queue:failed-table` · `queue:batches-table` | Migrations |
| `schedule:run` · `schedule:work` · `schedule:list` · `schedule:test` · `schedule:interrupt` · `schedule:pause` · `schedule:resume` · `schedule:clear-cache` | [Scheduling](/digging-deeper/scheduling) |

`cache:prune` is for the **database** store only — it has no expiry of its own, so
something has to sweep it. A scheduled `cache:prune --store=database` is the usual
answer.

## Configuration and caches

| Command | |
| --- | --- |
| `config:show` | What the application actually resolved — a file or one key |
| `config:publish` | Fetch a config file the kit did not ship |
| `mail:theme` | Write a copy of the mail stylesheet to edit |
| `config:cache` | Freeze every config file into one JSON document |
| `config:clear` | Undo that |
| `optimize` | `config:cache` + `app:build` |
| `optimize:clear` | Undo both |
| `app:build` | Bundle to `dist/elvel.js` |

`config:show` is the one to reach for when a value is not what you expected: it
prints what was resolved, after `.env`, defaults and the cache.

## Inspecting

| Command | |
| --- | --- |
| `route:list` | Every route, with its middleware |
| `middleware:list` | Aliases, groups, and **how many routes use each** |
| `event:list` | Registered listeners |
| `channel:list` | Broadcast channels and the order they match in |
| `log:tail` | Follow the log as it is written |

`middleware:list`'s route count is the useful column — a middleware at 0 is either
dead or a guard somebody forgot to apply.

`log:tail` takes `--level`, `--filter` and `--lines`, so it is `tail -f | grep`
without needing to know where the file is.

## Keys and secrets

| Command | |
| --- | --- |
| `key:generate` | Write `APP_KEY` |
| `auth:secret` | Write `AUTH_SECRET` |
| `env:encrypt` | Encrypt `.env` so it can be committed |
| `env:decrypt` | Decrypt it again |
| `encryption:rotate <table> <column>` | Re-encrypt a column onto the current key |

**`APP_KEY` and `AUTH_SECRET` are different keys and must stay different.** One
encrypts data, the other signs sessions; a single value doing both means a leak of
either is a leak of both.

`env:encrypt` takes `--env=staging` to encrypt `.env.staging`, and prints the key
it generated unless you pass `--key`. That key does **not** belong in the
repository — it goes wherever your deployment keeps secrets.

`encryption:rotate` walks a table and re-encrypts one column, which is how you
retire an old `APP_KEY` without losing the data encrypted under it. Without it,
rotating a key means every `encrypted` cast stops decrypting.

## Auth, storage, install

| Command | |
| --- | --- |
| `auth:schema` | Generate a migration for better-auth's tables |
| `auth:schema --diff` | Only what the database is missing — the one to use after the first migration |
| `session:gc` | Delete sessions idle past their lifetime — nothing else does |
| `storage:link` / `storage:unlink` | The symlinks `config/filesystems.ts` names |
| `session:table` · `notifications:table` | Migrations for those drivers |
| `install:api` | Add an API routes file and wire it into the bootstrap |
| `install:broadcasting` | Add the broadcasting config file |
| `stub:publish` | Publish the framework's stubs for editing |

`install:*` exists because a starter kit prunes what it does not use: an
application scaffolded with `--kit=none` has no API routes file, and this adds one
without re-scaffolding.

## Maintenance mode

```bash
bun elvel down --retry=60 --except=/health --with-secret
bun elvel down --render=errors.maintenance
bun elvel up
```

[Middleware](/basics/middleware#maintenance-mode) has what `--with-secret` does
and why the payload lives in a file.
