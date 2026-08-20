# Installation

One command, and the application it writes is yours — there is nothing to
`eject` from later.

```bash
bun create elvel my-app
cd my-app
bun run dev
```

That is the whole of it: the scaffolder installs the packages, writes an `.env`
with its own generated secrets, and runs the migrations, so there is no
`key:generate` step and no placeholder key to rotate.

Three starter kits, chosen with `--kit` or at the prompt:

| | what it is | providers | dependencies |
|---|---|---:|---:|
| `none` | a landing page, no database | 10 | 14 |
| `auth` | sign in, sign up, a dashboard, settings | 17 | 22 |
| `api` | bearer-token auth, JSON, no views | 16 | 21 |

**An application installs only what its kit uses.** This is the one place Elvel
departs from Laravel by necessity: Laravel's components arrive inside a single
Composer package whether or not you touch them, while these are twenty-seven npm
packages, and registering all of them took a landing page from 1.0 MB to 3.7 MB.
So `bootstrap/providers.ts` lists what an application registers, and the kit
decides what goes in it.

Adding something later is three steps and the framework has all three — a
database, for instance, which `--kit=none` does not install:

```bash
bun add @elvel/database
bun elvel config:publish database
```

then a line in `bootstrap/providers.ts`. After that `make:model`, `migrate` and
the rest are registered.

The drivers that ship need nothing running — `cache=file`, `queue=sync`,
`mail=log`, `disk=local`, SQLite — so `bun run dev` works before Docker does.
Switching one to `database` is an env change plus the migration its command
writes: `elvel cache:table`, `queue:table`, `queue:failed-table`,
`notifications:table`.

Open `http://localhost:3000`.

```bash
bun run elvel                            # list commands
bun run elvel about
bun run elvel route:list
bun run elvel make:controller Post -r
bun run elvel make:view pages.about
bun run elvel make:component Alert
bun run elvel make:provider Route
bun run elvel make:command SendReports
bun run elvel migrate
bun run elvel migrate:rollback --step=2
bun run elvel migrate:status
bun run elvel make:migration create_posts_table
bun run elvel make:model Post -mfs        # model + migration + factory + seeder
bun run elvel db:seed
bun run elvel db:show
bun run elvel db:table users
bun run elvel make:event OrderShipped
bun run elvel make:listener RecordShipments --event OrderShipped
```
