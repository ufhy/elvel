# Console

`elvel` is the CLI — Laravel's `artisan`, renamed. Every command in every
installed package shows up in one list, grouped by prefix:

```bash
bun elvel list
bun elvel about
bun elvel <command> --help
```

```
  about                 Display basic information about the application
  serve                 Serve the application on the Bun development server
  ...
 cache
  cache:clear           Flush the application cache
  cache:forget          Remove an item from the cache
```

The application is **fully booted** before a command runs, which is why `serve`,
`route:list` and `about` can inspect the real container and the real route table
rather than a static description of them.

## Writing one

```bash
bun elvel make:command SendDigest
```

```ts
import { Command } from '@elvel/console'

export class SendDigest extends Command {
  static override signature = 'send:digest {name : The thing to act on} {--force : Skip confirmation}'
  static override description = 'Describe what SendDigest does'

  async handle(): Promise<number> {
    const name = this.argument('name')

    if (!this.flag('force') && !(await this.confirm(`Continue with ${name}?`, true))) {
      this.warn('Aborted.')
      return 1
    }

    this.success(`Done: ${name}`)
    return 0
  }
}
```

Nothing registers it. Application commands are **discovered** from
`app/Console/Commands`, so the file appearing is the command appearing:

```
$ bun elvel send:digest reports --force
✔ Done: reports

$ bun elvel send:digest reports
  No
⚠ Aborted.
```

## The signature

One string declares the whole interface, and `--help` is generated from it:

```
{name}              required argument
{name?}             optional
{name=default}      optional with a default
{name*}             takes several
{name : What it is} described

{--force}           a flag
{--path=}           takes a value
{--path=default}    with a default
{--P|path=}         with a shortcut
{--tag*}            repeatable
```

```
$ bun elvel send:digest --help

Usage:
  bun elvel send:digest <name> [options]

Arguments:
  name  The thing to act on

Options:
  --force  Skip confirmation
```

Read the input back with `argument`, `arrayArgument`, `option`, `flag`,
`stringOption` and `arrayOption` — one method per shape, so a flag that was
declared as a flag cannot be read as a string by accident.

## Talking to the person running it

```ts
this.line('plain')
this.info('blue')
this.success('a tick')
this.comment('dim')
this.warn('a warning')
this.error('red, on stderr')
this.table(['Name', 'Size'], rows)
```

```ts
const name = await this.ask('Name?', 'default')
const token = await this.secret('Token?')
const yes = await this.confirm('Overwrite?', true)
const kind = await this.choice('Which?', ['a', 'b'], 'a')
```

`this.call('migrate', ['--force'])` runs another command from inside this one —
Laravel's `$this->call()`.

Return a number from `handle()` to set the exit code; returning nothing means
success.

## `--isolated`

```bash
bun elvel migrate --isolated
```

Runs only if no other copy holds the lock — the case being a deploy that runs
`migrate` on every node at once, where exactly one of them should do the work.

It is opt-in **per command**, through `static isolatable = true`, because a lock
is only meaningful where a second copy would do damage. Marking everything
isolatable would invite locks on commands where refusing to run is worse than
running twice. It needs a cache store, and says so rather than running
unprotected:

```
--isolated needs a cache store. Register CacheServiceProvider.
```

## Generators

```bash
bun elvel make:controller PostController
bun elvel make:model Post
bun elvel make:middleware EnsureSubscribed
bun elvel make:job SendWelcomeEmail
bun elvel make:event OrderShipped
bun elvel make:listener SendShipmentNotification
bun elvel make:provider BillingServiceProvider
bun elvel make:view pages/pricing
bun elvel make:test ArticleTest
```

Every generator reads a stub, and the stubs are yours to change:

```bash
bun elvel stub:publish --list   # what would be published, and from where
bun elvel stub:publish
```

```
Stub                From
command.stub        packages/console/stubs
cast.stub           packages/database/stubs
cache-table.stub    packages/cache/stubs
```

Each package ships the stubs for the things it generates, so publishing collects
them from wherever they live rather than from one directory that would have to
know about every package.

## Configuration and maintenance

```bash
bun elvel config:show database        # what the application actually resolved
bun elvel config:publish mail         # fetch a config file the kit did not ship
bun elvel config:cache                # freeze it into bootstrap/cache/config.json
bun elvel config:clear
bun elvel env
bun elvel down --secret=…             # maintenance mode, with a way past it
bun elvel up
```

## `optimize`, and what boot costs

```bash
bun elvel optimize
```

```
 INFO  Cached 8 config file(s): bootstrap/cache/config.json
 INFO  Built dist/elvel.js (1.41 MB)
 INFO  Cached: config:cache, app:build.
```

Booting is what costs. Bun re-transpiles every module in every process — roughly
a thousand files for a full application — and nothing is cached between runs. So
`elvel.ts` hands over to `dist/elvel.js` **when a bundle exists and is newer than
every source file, `package.json` and `bun.lock`**. Any of those touched after
the build makes it stale, and a stale bundle is simply not used.

That comparison is by modification time rather than content, because it runs
before every command and hashing a thousand files would cost more than it saves.
Nothing changes until `app:build` writes a bundle: a fast path nobody opted into
is a fast path that will one day run yesterday's code.

`config:cache` is the other half. It refuses quietly-wrong input rather than
freezing it — a config value that is a function cannot be serialised, so it says
so and leaves that one live:

```
config/app.ts holds a function at [app.providers.0] — read live.
```

## Running the application

```bash
bun elvel serve          # the Bun development server
bun elvel dev            # server (--hot), Vite, a queue worker and the scheduler
bun elvel route:list     # every route, with its middleware
bun elvel app:build      # bundle to dist/elvel.js
```

`dev` runs the server under `bun --hot` and starts Vite alongside it, which is
what makes the browser reload when a view changes — see
[live reload](/basics/views#live-reload). It skips a worker the application does
not have: `--kit=none` prunes the queue and the scheduler, and starting them
there failed with `Command "queue:work" is not defined`, taking the server down
with it.

Vite runs where `config/vite.ts` says the client project is — `projectDirectory`,
`.` by default, and `frontend` for a client that is its own project. `vite` is
resolved from there too, since that is where it is installed. The line `dev` prints
says which:

```
Assets:  starting in frontend, its port is reported below
Assets:  http://localhost:5173
```

It says so when there is nothing to start, as well: `vite is not installed in
frontend, so there is no browser reload`. Silence there is how a browser that
stopped refreshing becomes a mystery.

`route:list` prints what Elysia actually registered, including the routes a
package added:

```
METHOD   PATH                      MIDDLEWARE
GET      /
DELETE   /api/auth
GET      /api/auth
```

## Testing a command

```ts
import { Output } from '@elvel/console'
import { elvel } from '@elvel/testing'

const command = await elvel(kernel, ['make:model', 'Post'], Output.prototype)
  .expectsConfirmation('Overwrite', true)
  .run()

command.assertSuccessful().assertOutputContains('Created')
```

The [testing page](/testing/getting-started#commands) has the rest.
